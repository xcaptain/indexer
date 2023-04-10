/* eslint-disable @typescript-eslint/no-explicit-any */

import { splitSignature } from "@ethersproject/bytes";
import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import Joi from "joi";

import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { regex } from "@/common/utils";
import { config } from "@/config/index";
import * as crossPostingOrdersModel from "@/models/cross-posting-orders";
import * as orders from "@/orderbook/orders";

import * as postOrderExternal from "@/jobs/orderbook/post-order-external";

const version = "v4";

export const postOrderV4Options: RouteOptions = {
  description: "Submit signed orders",
  tags: ["api", "Create Orders (list & bid)"],
  plugins: {
    "hapi-swagger": {
      order: 5,
    },
  },
  validate: {
    query: Joi.object({
      signature: Joi.string().lowercase().pattern(regex.bytes),
    }),
    payload: Joi.object({
      items: Joi.array()
        .items(
          Joi.object({
            order: Joi.object({
              kind: Joi.string()
                .lowercase()
                .valid(
                  "blur",
                  "opensea",
                  "looks-rare",
                  "zeroex-v4",
                  "seaport",
                  "seaport-v1.4",
                  "x2y2",
                  "universe",
                  "forward",
                  "infinity",
                  "flow",
                  "alienswap"
                )
                .required(),
              data: Joi.object().required(),
            }),
            orderbook: Joi.string()
              .lowercase()
              .valid(
                "blur",
                "reservoir",
                "opensea",
                "looks-rare",
                "x2y2",
                "universe",
                "infinity",
                "flow"
              )
              .default("reservoir"),
            orderbookApiKey: Joi.string().description("Optional API key for the target orderbook"),
            attribute: Joi.object({
              collection: Joi.string().required(),
              key: Joi.string().required(),
              value: Joi.string().required(),
            }),
            collection: Joi.string(),
            tokenSetId: Joi.string(),
            isNonFlagged: Joi.boolean(),
            bulkData: Joi.object({
              kind: Joi.string().valid("seaport-v1.4", "alienswap").default("seaport-v1.4"),
              data: Joi.object({
                orderIndex: Joi.number().required(),
                merkleProof: Joi.array().items(Joi.string()).required(),
              }),
            }),
          }).oxor("tokenSetId", "collection", "attribute")
        )
        .min(1),
      source: Joi.string().pattern(regex.domain).description("The source domain"),
    }),
  },
  response: {
    schema: Joi.object({
      results: Joi.array().items(
        Joi.object({
          message: Joi.string(),
          orderId: Joi.string().allow(null),
          orderIndex: Joi.number(),
          crossPostingOrderId: Joi.string().description(
            "Only available when posting to external orderbook. Can be used to retrieve the status of a cross-post order."
          ),
        })
      ),
    }).label(`postOrder${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`post-order-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    if (config.disableOrders) {
      throw Boom.badRequest("Order posting is disabled");
    }

    const payload = request.payload as any;
    const query = request.query as any;

    try {
      const items = payload.items as {
        order: { kind: string; data: any };
        orderbook: string;
        orderbookApiKey?: string;
        attribute?: { collection: string; key: string; value: string };
        collection?: string;
        tokenSetId?: string;
        isNonFlagged?: boolean;
        source?: string;
        bulkData?: {
          kind: "seaport-v1.4" | "alienswap";
          data: {
            orderIndex: number;
            merkleProof: string[];
          };
        };
      }[];

      // Only Seaport v1.4 and fork supports bulk orders
      if (items.length > 1) {
        if (
          !items.every(
            (item) => item.order.kind === "seaport-v1.4" || item.order.kind === "alienswap"
          )
        ) {
          throw Boom.badRequest("Bulk orders are only supported on Seaport v1.4");
        }
      }

      const results: {
        message: string;
        orderIndex: number;
        orderId?: string;
        crossPostingOrderId?: number;
      }[] = [];
      await Promise.all(
        items.map(async (item, i) => {
          const source = payload.source;
          const order = item.order;
          const orderbook = item.orderbook;
          const orderbookApiKey = item.orderbookApiKey;
          const bulkData = item.bulkData;

          // We'll always have only one of the below cases:
          // - only relevant/present for attribute bids
          const attribute = item.attribute;
          // - only relevant for collection bids
          const collection = item.collection;
          // - only relevant for token set bids
          const tokenSetId = item.tokenSetId;

          // - only relevant for non-flagged tokens bids
          const isNonFlagged = item.isNonFlagged;

          const signature = query.signature ?? order.data.signature;
          if (signature) {
            try {
              const { v, r, s } = splitSignature(signature);

              if (bulkData?.kind === "seaport-v1.4") {
                // Encode the merkle proof of inclusion together with the signature
                order.data.signature = new Sdk.SeaportV14.Exchange(
                  config.chainId
                ).encodeBulkOrderProofAndSignature(
                  bulkData.data.orderIndex,
                  bulkData.data.merkleProof,
                  signature
                );
              } else if (bulkData?.kind === "alienswap") {
                order.data.signature = new Sdk.Alienswap.Exchange(
                  config.chainId
                ).encodeBulkOrderProofAndSignature(
                  bulkData.data.orderIndex,
                  bulkData.data.merkleProof,
                  signature
                );
              } else {
                // If the signature is provided via query parameters, use it
                order.data = {
                  ...order.data,
                  // To cover everything:
                  // - orders requiring a single signature field
                  // - orders requiring split signature fields
                  signature,
                  v,
                  r,
                  s,
                };
              }
            } catch {
              // Skip errors
            }
          }

          let schema: any;
          if (attribute) {
            schema = {
              kind: "attribute",
              data: {
                collection: attribute.collection,
                isNonFlagged: isNonFlagged || undefined,
                attributes: [
                  {
                    key: attribute.key,
                    value: attribute.value,
                  },
                ],
              },
            };
          } else if (collection && isNonFlagged) {
            schema = {
              kind: "collection-non-flagged",
              data: {
                collection,
              },
            };
          } else if (collection) {
            schema = {
              kind: "collection",
              data: {
                collection,
              },
            };
          } else if (tokenSetId) {
            schema = {
              kind: "token-set",
              data: {
                tokenSetId,
              },
            };
          }

          switch (order.kind) {
            case "blur": {
              let crossPostingOrder;
              let orderId: string;

              if (orderbook === "blur") {
                orderId = order.data.id;

                crossPostingOrder = await crossPostingOrdersModel.saveOrder({
                  orderId,
                  kind: order.kind,
                  orderbook,
                  source,
                  schema,
                  rawData: order.data,
                } as crossPostingOrdersModel.CrossPostingOrder);

                await postOrderExternal.addToQueue({
                  crossPostingOrderId: crossPostingOrder.id,
                  orderId,
                  orderData: { ...order.data, signature },
                  orderSchema: schema,
                  orderbook,
                  orderbookApiKey,
                });
              } else if (orderbook === "reservoir") {
                const [result] = await orders.blur.saveListings([
                  {
                    orderParams: order.data,
                    metadata: {
                      schema,
                    },
                  },
                ]);

                orderId = result.id;

                if (!["success", "already-exists"].includes(result.status)) {
                  return results.push({ message: result.status, orderIndex: i, orderId });
                }
              } else {
                return results.push({ message: "unsupported-orderbook", orderIndex: i });
              }

              return results.push({
                message: "success",
                orderIndex: i,
                orderId,
                crossPostingOrderId: crossPostingOrder?.id,
              });
            }

            case "zeroex-v4": {
              if (orderbook !== "reservoir") {
                return results.push({ message: "unsupported-orderbook", orderIndex: i });
              }

              const orderInfo: orders.zeroExV4.OrderInfo = {
                orderParams: order.data,
                metadata: {
                  schema,
                  source,
                },
              };

              // Only the relayer can post Coinbase NFT orders
              if (orderInfo.orderParams.cbOrderId) {
                return results.push({ message: "unauthorized", orderIndex: i });
              }

              const [result] = await orders.zeroExV4.save([orderInfo]);

              if (["already-exists", "success"].includes(result.status)) {
                return results.push({ message: "success", orderIndex: i, orderId: result.id });
              } else {
                return results.push({ message: result.status, orderIndex: i, orderId: result.id });
              }
            }

            case "alienswap":
            case "seaport":
            case "seaport-v1.4": {
              if (!["opensea", "reservoir"].includes(orderbook)) {
                return results.push({ message: "unsupported-orderbook", orderIndex: i });
              }

              let crossPostingOrder;

              const orderId =
                order.kind === "seaport"
                  ? new Sdk.SeaportV11.Order(config.chainId, order.data).hash()
                  : new Sdk.SeaportV14.Order(config.chainId, order.data).hash();

              if (orderbook === "opensea") {
                crossPostingOrder = await crossPostingOrdersModel.saveOrder({
                  orderId,
                  kind: order.kind,
                  orderbook,
                  source,
                  schema,
                  rawData: order.data,
                } as crossPostingOrdersModel.CrossPostingOrder);

                await postOrderExternal.addToQueue({
                  crossPostingOrderId: crossPostingOrder.id,
                  orderId,
                  orderData: order.data,
                  orderSchema: schema,
                  orderbook,
                  orderbookApiKey,
                });
              } else if (orderbook === "reservoir") {
                if (order.kind === "seaport") {
                  const [result] = await orders.seaport.save([
                    {
                      orderParams: order.data,
                      isReservoir: true,
                      metadata: {
                        schema,
                        source,
                      },
                    },
                  ]);
                  if (!["success", "already-exists"].includes(result.status)) {
                    return results.push({ message: result.status, orderIndex: i, orderId });
                  }
                } else if (order.kind == "seaport-v1.4") {
                  const [result] = await orders.seaportV14.save([
                    {
                      orderParams: order.data,
                      isReservoir: true,
                      metadata: {
                        schema,
                        source,
                      },
                    },
                  ]);
                  if (!["success", "already-exists"].includes(result.status)) {
                    return results.push({ message: result.status, orderIndex: i, orderId });
                  }
                } else {
                  const [result] = await orders.alienswap.save([
                    {
                      orderParams: order.data,
                      isReservoir: true,
                      metadata: {
                        schema,
                        source,
                      },
                    },
                  ]);
                  if (!["success", "already-exists"].includes(result.status)) {
                    return results.push({ message: result.status, orderIndex: i, orderId });
                  }
                }

                if (config.forwardReservoirApiKeys.includes(request.headers["x-api-key"])) {
                  const orderResult = await idb.oneOrNone(
                    `
                    SELECT
                      orders.token_set_id
                    FROM orders
                    WHERE orders.id = $/id/
                  `,
                    { id: orderId }
                  );

                  if (orderResult?.token_set_id?.startsWith("token")) {
                    await postOrderExternal.addToQueue({
                      orderId,
                      orderData: order.data,
                      orderSchema: schema,
                      orderbook: "opensea",
                      orderbookApiKey: config.forwardOpenseaApiKey,
                    });
                  }
                }
              }

              return results.push({
                message: "success",
                orderIndex: i,
                orderId,
                crossPostingOrderId: crossPostingOrder?.id,
              });
            }

            case "looks-rare": {
              if (!["looks-rare", "reservoir"].includes(orderbook)) {
                return results.push({ message: "unsupported-orderbook", orderIndex: i });
              }

              let crossPostingOrder;

              const orderId = new Sdk.LooksRare.Order(config.chainId, order.data).hash();

              if (orderbook === "looks-rare") {
                crossPostingOrder = await crossPostingOrdersModel.saveOrder({
                  orderId,
                  kind: order.kind,
                  orderbook,
                  source,
                  schema,
                  rawData: order.data,
                } as crossPostingOrdersModel.CrossPostingOrder);

                await postOrderExternal.addToQueue({
                  crossPostingOrderId: crossPostingOrder.id,
                  orderId,
                  orderData: order.data,
                  orderSchema: schema,
                  orderbook,
                  orderbookApiKey,
                });
              } else {
                const [result] = await orders.looksRare.save([
                  {
                    orderParams: order.data,
                    metadata: {
                      schema,
                      source,
                    },
                  },
                ]);

                if (!["success", "already-exists"].includes(result.status)) {
                  return results.push({ message: result.status, orderIndex: i, orderId });
                }
              }

              return results.push({
                message: "success",
                orderIndex: i,
                orderId,
                crossPostingOrderId: crossPostingOrder?.id,
              });
            }

            case "x2y2": {
              if (!["x2y2", "reservoir"].includes(orderbook)) {
                return results.push({ message: "unsupported-orderbook", orderIndex: i });
              }

              let crossPostingOrder;
              let orderId = undefined;

              if (orderbook === "x2y2") {
                // We do not save the order directly since X2Y2 orders are not fillable
                // unless their backend has processed them first. So we just need to be
                // patient until the relayer acknowledges the order (via X2Y2's server)
                // before us being able to ingest it.
                crossPostingOrder = await crossPostingOrdersModel.saveOrder({
                  orderId: orderId || null,
                  kind: order.kind,
                  orderbook,
                  source,
                  schema,
                  rawData: order.data,
                } as crossPostingOrdersModel.CrossPostingOrder);

                await postOrderExternal.addToQueue({
                  crossPostingOrderId: crossPostingOrder.id,
                  orderId: orderId || null,
                  orderData: order.data,
                  orderSchema: schema,
                  orderbook,
                  orderbookApiKey,
                });
              } else {
                const [result] = await orders.x2y2.save([
                  {
                    orderParams: order.data,
                    metadata: {
                      schema,
                    },
                  },
                ]);

                orderId = result.id;

                if (!["success", "already-exists"].includes(result.status)) {
                  return results.push({ message: result.status, orderIndex: i, orderId });
                }
              }

              return results.push({
                message: "success",
                orderIndex: i,
                orderId,
                crossPostingOrderId: crossPostingOrder?.id,
              });
            }

            case "universe": {
              if (!["universe"].includes(orderbook)) {
                return results.push({ message: "unsupported-orderbook", orderIndex: i });
              }

              const orderId = new Sdk.Universe.Order(config.chainId, order.data).hashOrderKey();

              const crossPostingOrder = await crossPostingOrdersModel.saveOrder({
                orderId,
                kind: order.kind,
                orderbook,
                source,
                schema,
                rawData: order.data,
              } as crossPostingOrdersModel.CrossPostingOrder);

              await postOrderExternal.addToQueue({
                crossPostingOrderId: crossPostingOrder.id,
                orderId,
                orderData: order.data,
                orderSchema: schema,
                orderbook: "universe",
                orderbookApiKey,
              });

              return results.push({
                message: "success",
                orderIndex: i,
                orderId,
                crossPostingOrderId: crossPostingOrder.id,
              });
            }

            case "infinity": {
              if (!["infinity"].includes(orderbook)) {
                return results.push({ message: "unsupported-orderbook", orderIndex: i });
              }

              const orderId = new Sdk.Infinity.Order(config.chainId, order.data).hash();

              const crossPostingOrder = await crossPostingOrdersModel.saveOrder({
                orderId,
                kind: order.kind,
                orderbook,
                source,
                schema,
                rawData: order.data,
              } as crossPostingOrdersModel.CrossPostingOrder);

              await postOrderExternal.addToQueue({
                crossPostingOrderId: crossPostingOrder.id,
                orderId,
                orderData: order.data,
                orderSchema: schema,
                orderbook: "infinity",
                orderbookApiKey,
              });

              return results.push({
                message: "success",
                orderIndex: i,
                orderId,
                crossPostingOrderId: crossPostingOrder.id,
              });
            }

            case "flow": {
              if (!["flow"].includes(orderbook)) {
                return results.push({ message: "unsupported-orderbook", orderIndex: i });
              }

              const orderId = new Sdk.Flow.Order(config.chainId, order.data).hash();

              const crossPostingOrder = await crossPostingOrdersModel.saveOrder({
                orderId,
                kind: order.kind,
                orderbook,
                source,
                schema,
                rawData: order.data,
              } as crossPostingOrdersModel.CrossPostingOrder);

              await postOrderExternal.addToQueue({
                crossPostingOrderId: crossPostingOrder.id,
                orderId,
                orderData: order.data,
                orderSchema: schema,
                orderbook: "flow",
                orderbookApiKey,
              });

              return results.push({
                message: "success",
                orderIndex: i,
                orderId,
                crossPostingOrderId: crossPostingOrder.id,
              });
            }
          }
        })
      );

      return { results };
    } catch (error) {
      logger.error(`post-order-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
