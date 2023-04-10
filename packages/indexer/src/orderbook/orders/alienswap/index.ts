import { AddressZero } from "@ethersproject/constants";
import * as Sdk from "@reservoir0x/sdk";
import _ from "lodash";
import pLimit from "p-limit";
import axios from "axios";

import { idb, pgp } from "@/common/db";
import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { redis } from "@/common/redis";
import tracer from "@/common/tracer";
import { bn, now, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { getNetworkSettings } from "@/config/network";
import { Collections } from "@/models/collections";
import { Sources } from "@/models/sources";
import { SourcesEntity } from "@/models/sources/sources-entity";
import { DbOrder, OrderMetadata, generateSchemaHash } from "@/orderbook/orders/utils";
import { offChainCheck } from "@/orderbook/orders/seaport-base/check";
import * as tokenSet from "@/orderbook/token-sets";
import { getUSDAndNativePrices } from "@/utils/prices";
import * as royalties from "@/utils/royalties";

import * as arweaveRelay from "@/jobs/arweave-relay";
import * as ordersUpdateById from "@/jobs/order-updates/by-id-queue";
import { allPlatformFeeRecipients } from "@/events-sync/handlers/royalties/config";

export type OrderInfo = {
  kind?: "full";
  orderParams: Sdk.SeaportBase.Types.OrderComponents;
  metadata: OrderMetadata;
  isReservoir?: boolean;
  isOpenSea?: boolean;
};

type SaveResult = {
  id: string;
  status: string;
  unfillable?: boolean;
  delay?: number;
};

export const save = async (
  orderInfos: OrderInfo[],
  relayToArweave?: boolean,
  validateBidValue?: boolean
): Promise<SaveResult[]> => {
  const results: SaveResult[] = [];
  const orderValues: DbOrder[] = [];

  const arweaveData: {
    order: Sdk.SeaportBase.IOrder;
    schemaHash?: string;
    source?: string;
  }[] = [];

  const handleOrder = async (
    orderParams: Sdk.SeaportBase.Types.OrderComponents,
    metadata: OrderMetadata,
    isReservoir?: boolean,
    isOpenSea?: boolean
  ) => {
    try {
      const order = new Sdk.Alienswap.Order(config.chainId, orderParams);
      const info = order.getInfo();
      const id = order.hash();

      // Check: order has a valid format
      if (!info) {
        return results.push({
          id,
          status: "invalid-format",
        });
      }

      // Check: order doesn't already exist
      const orderExists = await idb.oneOrNone(
        `
          WITH x AS (
            UPDATE orders
            SET
              raw_data = $/rawData/,
              updated_at = now()
            WHERE orders.id = $/id/
              AND raw_data IS NULL
          )
          SELECT 1 FROM orders WHERE orders.id = $/id/
        `,
        {
          id,
          rawData: order.params,
        }
      );

      if (orderExists) {
        return results.push({
          id,
          status: "already-exists",
        });
      }

      // Check: order has a non-zero price
      if (bn(info.price).lte(0)) {
        return results.push({
          id,
          status: "zero-price",
        });
      }

      const currentTime = now();
      const inTheFutureThreshold = 7 * 24 * 60 * 60;

      // Check: order has a valid start time
      const startTime = order.params.startTime;
      if (startTime - inTheFutureThreshold >= currentTime) {
        // TODO: Add support for not-yet-valid orders
        return results.push({
          id,
          status: "invalid-start-time",
        });
      }

      // Delay the validation of the order if it's start time is very soon in the future
      if (startTime > currentTime) {
        return results.push({
          id,
          status: "delayed",
          delay: startTime - currentTime + 5,
        });
      }

      // Check: order is not expired
      const endTime = order.params.endTime;
      if (currentTime >= endTime) {
        return results.push({
          id,
          status: "expired",
        });
      }

      // Check: buy order has a supported payment token
      if (info.side === "buy" && !getNetworkSettings().supportedBidCurrencies[info.paymentToken]) {
        return results.push({
          id,
          status: "unsupported-payment-token",
        });
      }

      // Check: order is partially-fillable
      const quantityRemaining = info.amount ?? "1";
      if ([0, 2].includes(order.params.orderType) && bn(quantityRemaining).gt(1)) {
        return results.push({
          id,
          status: "not-partially-fillable",
        });
      }

      // Check: order has a known zone
      if (order.params.orderType > 1) {
        if (
          ![
            // No zone
            AddressZero,
            // Cancellation zone
            Sdk.SeaportV14.Addresses.CancellationZone[config.chainId],
          ].includes(order.params.zone)
        ) {
          return results.push({
            id,
            status: "unsupported-zone",
          });
        }
      }

      // Check: order is valid
      try {
        order.checkValidity();
      } catch {
        return results.push({
          id,
          status: "invalid",
        });
      }

      // Make sure no zero signatures are allowed
      if (order.params.signature && /^0x0+$/g.test(order.params.signature)) {
        order.params.signature = undefined;
      }

      // Check: order has a valid signature
      if (metadata.fromOnChain || (isOpenSea && !order.params.signature)) {
        // Skip if:
        // - the order was validated on-chain
        // - the order is coming from OpenSea and it doesn't have a signature
      } else {
        try {
          await order.checkSignature(baseProvider);
        } catch {
          return results.push({
            id,
            status: "invalid-signature",
          });
        }
      }

      // Check: order fillability
      let fillabilityStatus = "fillable";
      let approvalStatus = "approved";
      const exchange = new Sdk.Alienswap.Exchange(config.chainId);
      try {
        await offChainCheck(order, exchange, {
          onChainApprovalRecheck: true,
          singleTokenERC721ApprovalCheck: metadata.fromOnChain,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        // Keep any orders that can potentially get valid in the future
        if (error.message === "no-balance-no-approval") {
          fillabilityStatus = "no-balance";
          approvalStatus = "no-approval";
        } else if (error.message === "no-approval") {
          approvalStatus = "no-approval";
        } else if (error.message === "no-balance") {
          fillabilityStatus = "no-balance";
        } else {
          return results.push({
            id,
            status: "not-fillable",
          });
        }
      }

      // Check and save: associated token set
      let tokenSetId: string | undefined;
      const schemaHash = metadata.schemaHash ?? generateSchemaHash(metadata.schema);

      switch (order.params.kind) {
        case "single-token": {
          const typedInfo = info as typeof info & { tokenId: string };
          const tokenId = typedInfo.tokenId;

          tokenSetId = `token:${info.contract}:${tokenId}`;
          if (tokenId) {
            await tokenSet.singleToken.save([
              {
                id: tokenSetId,
                schemaHash,
                contract: info.contract,
                tokenId,
              },
            ]);
          }

          break;
        }

        case "contract-wide": {
          tokenSetId = `contract:${info.contract}`;
          await tokenSet.contractWide.save([
            {
              id: tokenSetId,
              schemaHash,
              contract: info.contract,
            },
          ]);

          break;
        }

        case "token-list": {
          const typedInfo = info as typeof info & { merkleRoot: string };
          const merkleRoot = typedInfo.merkleRoot;

          if (merkleRoot) {
            tokenSetId = `list:${info.contract}:${bn(merkleRoot).toHexString()}`;

            const ts = await tokenSet.tokenList.save([
              {
                id: tokenSetId,
                schemaHash,
                schema: metadata.schema,
              },
            ]);

            logger.info(
              "orders-alienswap-save",
              `TokenList. orderId=${id}, tokenSetId=${tokenSetId}, schemaHash=${schemaHash}, metadata=${JSON.stringify(
                metadata
              )}, ts=${JSON.stringify(ts)}`
            );
          }

          break;
        }
      }

      if (!tokenSetId) {
        return results.push({
          id,
          status: "invalid-token-set",
        });
      }

      // Handle: fees
      let feeAmount = order.getFeeAmount();

      // Handle: price and value
      let price = bn(order.getMatchingPrice());
      let value = price;
      if (info.side === "buy") {
        // For buy orders, we set the value as `price - fee` since it
        // is best for UX to show the user exactly what they're going
        // to receive on offer acceptance.
        value = bn(price).sub(feeAmount);
      }

      // The price, value and fee are for a single item
      if (bn(info.amount).gt(1)) {
        price = price.div(info.amount);
        value = value.div(info.amount);
        feeAmount = feeAmount.div(info.amount);
      }

      // Handle: royalties
      const openSeaFeeRecipients = [
        "0x5b3256965e7c3cf26e11fcaf296dfc8807c01073",
        "0x8de9c5a032463c561423387a9648c5c7bcc5bc90",
        "0x0000a26b00c1f0df003000390027140000faa719",
      ];

      let openSeaRoyalties: royalties.Royalty[];

      if (order.params.kind === "single-token") {
        openSeaRoyalties = await royalties.getRoyalties(info.contract, info.tokenId, "", true);
      } else {
        openSeaRoyalties = await royalties.getRoyaltiesByTokenSet(tokenSetId, "", true);
      }

      let feeBps = 0;
      let knownFee = false;
      const feeBreakdown = info.fees.map(({ recipient, amount }) => {
        const bps = price.eq(0)
          ? 0
          : bn(amount)
              .div(info.amount ?? 1)
              .mul(10000)
              .div(price)
              .toNumber();

        feeBps += bps;

        // First check for opensea hardcoded recipients
        const kind: "marketplace" | "royalty" = allPlatformFeeRecipients.has(
          recipient.toLowerCase()
        )
          ? "marketplace"
          : "royalty";

        // Check for unknown fees
        knownFee =
          knownFee ||
          !openSeaRoyalties.map(({ recipient }) => recipient).includes(recipient.toLowerCase()); // Check for locally stored royalties

        return {
          kind,
          recipient,
          bps,
        };
      });

      if (feeBps > 10000) {
        return results.push({
          id,
          status: "fees-too-high",
        });
      }

      // Handle: royalties on top
      const defaultRoyalties =
        info.side === "sell"
          ? await royalties.getRoyalties(info.contract, info.tokenId, "default")
          : await royalties.getRoyaltiesByTokenSet(tokenSetId, "default");

      const totalBuiltInBps = feeBreakdown
        .map(({ bps, kind }) => (kind === "royalty" ? bps : 0))
        .reduce((a, b) => a + b, 0);
      const totalDefaultBps = defaultRoyalties.map(({ bps }) => bps).reduce((a, b) => a + b, 0);

      const missingRoyalties = [];
      let missingRoyaltyAmount = bn(0);
      if (totalBuiltInBps < totalDefaultBps) {
        const validRecipients = defaultRoyalties.filter(
          ({ bps, recipient }) => bps && recipient !== AddressZero
        );
        if (validRecipients.length) {
          const bpsDiff = totalDefaultBps - totalBuiltInBps;
          const amount = bn(price).mul(bpsDiff).div(10000);
          missingRoyaltyAmount = missingRoyaltyAmount.add(amount);

          // Split the missing royalties pro-rata across all royalty recipients
          const totalBps = _.sumBy(validRecipients, ({ bps }) => bps);
          for (const { bps, recipient } of validRecipients) {
            // TODO: Handle lost precision (by paying it to the last or first recipient)
            missingRoyalties.push({
              bps: Math.floor((bpsDiff * bps) / totalBps),
              amount: amount.mul(bps).div(totalBps).toString(),
              recipient,
            });
          }
        }
      }

      // Handle: source
      const sources = await Sources.getInstance();
      let source: SourcesEntity | undefined = await sources.getOrInsert("opensea.io");

      // If cross posting, source should always be opensea.
      const sourceHash = bn(order.params.salt)._hex.slice(0, 10);
      const matchedSource = sources.getByDomainHash(sourceHash);
      if (matchedSource) {
        source = matchedSource;
      }

      // If the order is native, override any default source
      if (isReservoir) {
        if (metadata.source) {
          // If we can detect the marketplace (only OpenSea for now) do not override
          if (
            _.isEmpty(
              _.intersection(
                feeBreakdown.map(({ recipient }) => recipient),
                openSeaFeeRecipients
              )
            )
          ) {
            source = await sources.getOrInsert(metadata.source);
          }
        } else {
          source = undefined;
        }
      }

      // Handle: price conversion
      const currency = info.paymentToken;

      const currencyPrice = price.toString();
      const currencyValue = value.toString();

      let needsConversion = false;
      if (
        ![
          Sdk.Common.Addresses.Eth[config.chainId],
          Sdk.Common.Addresses.Weth[config.chainId],
        ].includes(currency)
      ) {
        needsConversion = true;

        // If the currency is anything other than ETH/WETH, we convert
        // `price` and `value` from that currency denominations to the
        // ETH denomination
        {
          const prices = await getUSDAndNativePrices(currency, price.toString(), currentTime);
          if (!prices.nativePrice) {
            // Getting the native price is a must
            return results.push({
              id,
              status: "failed-to-convert-price",
            });
          }
          price = bn(prices.nativePrice);
        }
        {
          const prices = await getUSDAndNativePrices(currency, value.toString(), currentTime);
          if (!prices.nativePrice) {
            // Getting the native price is a must
            return results.push({
              id,
              status: "failed-to-convert-price",
            });
          }
          value = bn(prices.nativePrice);
        }
      }

      // Handle: normalized value
      const currencyNormalizedValue =
        info.side === "sell"
          ? bn(currencyValue).add(missingRoyaltyAmount).toString()
          : bn(currencyValue).sub(missingRoyaltyAmount).toString();

      const prices = await getUSDAndNativePrices(currency, currencyNormalizedValue, currentTime);
      if (!prices.nativePrice) {
        // Getting the native price is a must
        return results.push({
          id,
          status: "failed-to-convert-price",
        });
      }
      const normalizedValue = bn(prices.nativePrice).toString();

      if (info.side === "buy" && order.params.kind === "single-token" && validateBidValue) {
        const typedInfo = info as typeof info & { tokenId: string };
        const tokenId = typedInfo.tokenId;
        const seaportBidPercentageThreshold = 80;

        try {
          const collectionFloorAskValue = await getCollectionFloorAskValue(
            info.contract,
            Number(tokenId)
          );

          if (collectionFloorAskValue) {
            const percentage = (Number(value.toString()) / collectionFloorAskValue) * 100;

            if (percentage < seaportBidPercentageThreshold) {
              return results.push({
                id,
                status: "bid-too-low",
              });
            }
          }
        } catch (error) {
          logger.warn(
            "orders-alienswap-save",
            `Bid value validation - error. orderId=${id}, contract=${info.contract}, tokenId=${tokenId}, error=${error}`
          );
        }
      }

      // Handle: off-chain cancellation via replacement
      if (order.params.zone === Sdk.SeaportV14.Addresses.CancellationZone[config.chainId]) {
        const replacedOrderResult = await idb.oneOrNone(
          `
            SELECT
              orders.raw_data
            FROM orders
            WHERE orders.id = $/id/
          `,
          {
            id: order.params.salt,
          }
        );
        if (
          replacedOrderResult &&
          // Replacement is only possible if the replaced order is an off-chain cancellable one
          replacedOrderResult.raw_data.zone ===
            Sdk.SeaportV14.Addresses.CancellationZone[config.chainId]
        ) {
          await axios.post(
            `https://seaport-oracle-${
              config.chainId === 1 ? "mainnet" : "goerli"
            }.up.railway.app/api/replacements`,
            {
              newOrders: [order.params],
              replacedOrders: [replacedOrderResult.raw_data],
            }
          );
        }
      }

      const validFrom = `date_trunc('seconds', to_timestamp(${startTime}))`;
      const validTo = endTime
        ? `date_trunc('seconds', to_timestamp(${order.params.endTime}))`
        : "'infinity'";
      orderValues.push({
        id,
        kind: order.getKind(),
        side: info.side,
        fillability_status: fillabilityStatus,
        approval_status: approvalStatus,
        token_set_id: tokenSetId,
        token_set_schema_hash: toBuffer(schemaHash),
        maker: toBuffer(order.params.offerer),
        taker: toBuffer(info.taker),
        price: price.toString(),
        value: value.toString(),
        currency: toBuffer(info.paymentToken),
        currency_price: currencyPrice.toString(),
        currency_value: currencyValue.toString(),
        needs_conversion: needsConversion,
        quantity_remaining: quantityRemaining,
        valid_between: `tstzrange(${validFrom}, ${validTo}, '[]')`,
        nonce: bn(order.params.counter).toString(),
        source_id_int: source?.id,
        is_reservoir: isReservoir ? isReservoir : null,
        contract: toBuffer(info.contract),
        conduit: toBuffer(
          new Sdk.Alienswap.Exchange(config.chainId).deriveConduit(order.params.conduitKey)
        ),
        fee_bps: feeBps,
        fee_breakdown: feeBreakdown || null,
        dynamic: info.isDynamic ?? null,
        raw_data: order.params,
        expiration: validTo,
        missing_royalties: missingRoyalties,
        normalized_value: normalizedValue,
        currency_normalized_value: currencyNormalizedValue,
        originated_at: metadata.originatedAt ?? null,
      });

      const unfillable =
        fillabilityStatus !== "fillable" ||
        approvalStatus !== "approved" ||
        // Skip private orders
        info.taker !== AddressZero
          ? true
          : undefined;

      results.push({
        id,
        status: "success",
        unfillable,
      });

      if (relayToArweave) {
        arweaveData.push({ order, schemaHash, source: source?.domain });
      }
    } catch (error) {
      logger.warn(
        "orders-alienswap-save",
        `Failed to handle order (will retry). orderParams=${JSON.stringify(
          orderParams
        )}, metadata=${JSON.stringify(metadata)}, isReservoir=${isReservoir}
        )}, error=${error}`
      );
    }
  };

  // Process all orders concurrently
  const limit = pLimit(20);
  await Promise.all(
    orderInfos.map((orderInfo) =>
      limit(async () =>
        tracer.trace("handleOrder", { resource: "alienswapSave" }, () =>
          handleOrder(
            orderInfo.orderParams as Sdk.SeaportBase.Types.OrderComponents,
            orderInfo.metadata,
            orderInfo.isReservoir,
            orderInfo.isOpenSea
          )
        )
      )
    )
  );

  if (orderValues.length) {
    const columns = new pgp.helpers.ColumnSet(
      [
        "id",
        "kind",
        "side",
        "fillability_status",
        "approval_status",
        "token_set_id",
        "token_set_schema_hash",
        "maker",
        "taker",
        "price",
        "value",
        "currency",
        "currency_price",
        "currency_value",
        "needs_conversion",
        "quantity_remaining",
        { name: "valid_between", mod: ":raw" },
        "nonce",
        "source_id_int",
        "is_reservoir",
        "contract",
        "conduit",
        "fee_bps",
        { name: "fee_breakdown", mod: ":json" },
        "dynamic",
        "raw_data",
        { name: "expiration", mod: ":raw" },
        { name: "missing_royalties", mod: ":json" },
        "normalized_value",
        "currency_normalized_value",
        "originated_at",
      ],
      {
        table: "orders",
      }
    );

    await idb.none(pgp.helpers.insert(orderValues, columns) + " ON CONFLICT DO NOTHING");

    await ordersUpdateById.addToQueue(
      results
        .filter((r) => r.status === "success" && !r.unfillable)
        .map(
          ({ id }) =>
            ({
              context: `new-order-${id}`,
              id,
              trigger: {
                kind: "new-order",
              },
            } as ordersUpdateById.OrderInfo)
        )
    );

    if (relayToArweave) {
      await arweaveRelay.addPendingOrdersSeaport(arweaveData);
    }
  }

  return results;
};

const getCollectionFloorAskValue = async (
  contract: string,
  tokenId: number
): Promise<number | undefined> => {
  if (getNetworkSettings().multiCollectionContracts.includes(contract)) {
    const collection = await Collections.getByContractAndTokenId(contract, tokenId);
    return collection?.floorSellValue;
  } else {
    const collectionFloorAskValue = await redis.get(`collection-floor-ask:${contract}`);

    if (collectionFloorAskValue) {
      return Number(collectionFloorAskValue);
    } else {
      const collection = await Collections.getByContractAndTokenId(contract, tokenId);
      const collectionFloorAskValue = collection?.floorSellValue || 0;

      await redis.set(`collection-floor-ask:${contract}`, collectionFloorAskValue, "EX", 3600);

      return collectionFloorAskValue;
    }
  }
};
