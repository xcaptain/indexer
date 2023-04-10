import { Interface } from "@ethersproject/abi";
import { Provider } from "@ethersproject/abstract-provider";
import { AddressZero } from "@ethersproject/constants";
import { Contract } from "@ethersproject/contracts";
import axios from "axios";

import * as Addresses from "./addresses";
import * as ApprovalProxy from "./approval-proxy";

import {
  BidDetails,
  ExecutionInfo,
  Fee,
  FTApproval,
  FillBidsResult,
  FillListingsResult,
  ListingDetails,
  ListingFillDetails,
  NFTApproval,
  PerCurrencyListingDetails,
  PerPoolSwapDetails,
  SwapDetail,
} from "./types";
import { generateSwapExecutions } from "./uniswap";
import { generateFTApprovalTxData, generateNFTApprovalTxData, isETH, isWETH } from "./utils";
import * as Sdk from "../../index";
import { encodeForMatchOrders } from "../../rarible/utils";
import { TxData, bn, generateSourceBytes, getErrorMessage, uniqBy } from "../../utils";

// Tokens
import ERC721Abi from "../../common/abis/Erc721.json";
import ERC1155Abi from "../../common/abis/Erc1155.json";
// Router
import RouterAbi from "./abis/ReservoirV6_0_1.json";
// Misc
import ApprovalProxyAbi from "./abis/ApprovalProxy.json";
// Modules
import ElementModuleAbi from "./abis/ElementModule.json";
import FoundationModuleAbi from "./abis/FoundationModule.json";
import LooksRareModuleAbi from "./abis/LooksRareModule.json";
import NFTXModuleAbi from "./abis/NFTXModule.json";
import RaribleModuleAbi from "./abis/RaribleModule.json";
import SeaportModuleAbi from "./abis/SeaportModule.json";
import SeaportV14ModuleAbi from "./abis/SeaportV14Module.json";
import AlienswapModuleAbi from "./abis/AlienswapModule.json";
import SudoswapModuleAbi from "./abis/SudoswapModule.json";
import SwapModuleAbi from "./abis/SwapModule.json";
import X2Y2ModuleAbi from "./abis/X2Y2Module.json";
import ZeroExV4ModuleAbi from "./abis/ZeroExV4Module.json";
import ZoraModuleAbi from "./abis/ZoraModule.json";

type SetupOptions = {
  x2y2ApiKey?: string;
  openseaApiKey?: string;
  cbApiKey?: string;
  orderFetcherBaseUrl?: string;
  orderFetcherApiKey?: string;
};

export class Router {
  public chainId: number;
  public provider: Provider;
  public options?: SetupOptions;

  public contracts: { [name: string]: Contract };

  constructor(chainId: number, provider: Provider, options?: SetupOptions) {
    this.chainId = chainId;
    this.provider = provider;
    this.options = options;

    this.contracts = {
      // Initialize router
      router: new Contract(Addresses.Router[chainId], RouterAbi, provider),
      // Initialize approval proxy
      approvalProxy: new Contract(
        Addresses.ApprovalProxy[chainId] ?? AddressZero,
        ApprovalProxyAbi,
        provider
      ),
      // Initialize modules
      elementModule: new Contract(
        Addresses.ElementModule[chainId] ?? AddressZero,
        ElementModuleAbi,
        provider
      ),
      foundationModule: new Contract(
        Addresses.FoundationModule[chainId] ?? AddressZero,
        FoundationModuleAbi,
        provider
      ),
      looksRareModule: new Contract(
        Addresses.LooksRareModule[chainId] ?? AddressZero,
        LooksRareModuleAbi,
        provider
      ),
      seaportModule: new Contract(
        Addresses.SeaportModule[chainId] ?? AddressZero,
        SeaportModuleAbi,
        provider
      ),
      seaportV14Module: new Contract(
        Addresses.SeaportV14Module[chainId] ?? AddressZero,
        SeaportV14ModuleAbi,
        provider
      ),
      sudoswapModule: new Contract(
        Addresses.SudoswapModule[chainId] ?? AddressZero,
        SudoswapModuleAbi,
        provider
      ),
      x2y2Module: new Contract(
        Addresses.X2Y2Module[chainId] ?? AddressZero,
        X2Y2ModuleAbi,
        provider
      ),
      zeroExV4Module: new Contract(
        Addresses.ZeroExV4Module[chainId] ?? AddressZero,
        ZeroExV4ModuleAbi,
        provider
      ),
      zoraModule: new Contract(
        Addresses.ZoraModule[chainId] ?? AddressZero,
        ZoraModuleAbi,
        provider
      ),
      nftxModule: new Contract(
        Addresses.NFTXModule[chainId] ?? AddressZero,
        NFTXModuleAbi,
        provider
      ),
      raribleModule: new Contract(
        Addresses.RaribleModule[chainId] ?? AddressZero,
        RaribleModuleAbi,
        provider
      ),
      swapModule: new Contract(
        Addresses.SwapModule[chainId] ?? AddressZero,
        SwapModuleAbi,
        provider
      ),
      alienswapModule: new Contract(
        Addresses.AlienswapModule[chainId] ?? AddressZero,
        AlienswapModuleAbi,
        provider
      ),
    };
  }

  public async fillListingsTx(
    details: ListingDetails[],
    taker: string,
    buyInCurrency = Sdk.Common.Addresses.Eth[this.chainId],
    options?: {
      source?: string;
      // Will be split among all listings to get filled
      globalFees?: Fee[];
      // Force filling through the router (where possible)
      forceRouter?: boolean;
      // Skip any errors (either off-chain or on-chain)
      partial?: boolean;
      // Any extra data relevant when filling natively
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      directFillingData?: any;
      // Wallet used for relaying the fill transaction
      relayer?: string;
      // Needed for filling Blur orders
      blurAuth?: {
        accessToken: string;
      };
      // Callback for handling recoverable errors
      onRecoverableError?: (
        kind: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error: any,
        data: {
          orderId: string;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          additionalInfo: any;
        }
      ) => Promise<void>;
    }
  ): Promise<FillListingsResult> {
    // Assume the listing details are consistent with the underlying order object

    // When filling a single order in partial mode, propagate any errors back directly
    if (options?.partial && details.length === 1) {
      options.partial = false;
    }

    // TODO: Add Universe router module
    if (details.some(({ kind }) => kind === "universe")) {
      if (options?.relayer) {
        throw new Error("Relayer not supported for Universe orders");
      }

      if (details.length > 1) {
        throw new Error("Universe sweeping is not supported");
      } else {
        if (options?.globalFees?.length) {
          throw new Error("Fees not supported for Universe orders");
        }

        const detail = details[0];

        let approval: FTApproval | undefined;
        if (!isETH(this.chainId, detail.currency)) {
          approval = {
            currency: detail.currency,
            amount: detail.price,
            owner: taker,
            operator: Sdk.Universe.Addresses.Exchange[this.chainId],
            txData: generateFTApprovalTxData(
              detail.currency,
              taker,
              Sdk.Universe.Addresses.Exchange[this.chainId]
            ),
          };
        }

        const order = detail.order as Sdk.Universe.Order;
        const exchange = new Sdk.Universe.Exchange(this.chainId);
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: await exchange.fillOrderTx(taker, order, {
                amount: Number(detail.amount),
                source: options?.source,
              }),
              orderIds: [detail.orderId],
            },
          ],
          success: { [detail.orderId]: true },
        };
      }
    }

    // TODO: Add Cryptopunks router module
    if (details.some(({ kind }) => kind === "cryptopunks")) {
      if (options?.relayer) {
        throw new Error("Relayer not supported for Cryptopunks orders");
      }

      if (details.length > 1) {
        throw new Error("Cryptopunks sweeping is not supported");
      } else {
        if (options?.globalFees?.length) {
          throw new Error("Fees not supported for Cryptopunks orders");
        }

        const detail = details[0];

        const order = detail.order as Sdk.CryptoPunks.Order;
        const exchange = new Sdk.CryptoPunks.Exchange(this.chainId);
        return {
          txs: [
            {
              approvals: [],
              txData: exchange.fillListingTx(taker, order, options),
              orderIds: [detail.orderId],
            },
          ],
          success: { [detail.orderId]: true },
        };
      }
    }

    // TODO: Add Infinity router module
    if (details.some(({ kind }) => kind === "infinity")) {
      if (options?.relayer) {
        throw new Error("Relayer not supported for Infinity orders");
      }

      if (details.length > 1) {
        throw new Error("Infinity sweeping is not supported");
      } else {
        if (options?.globalFees?.length) {
          throw new Error("Fees not supported for Infinity orders");
        }

        const detail = details[0];

        let approval: FTApproval | undefined;
        if (!isETH(this.chainId, detail.currency)) {
          approval = {
            currency: detail.currency,
            amount: detail.price,
            owner: taker,
            operator: Sdk.Infinity.Addresses.Exchange[this.chainId],
            txData: generateFTApprovalTxData(
              detail.currency,
              taker,
              Sdk.Infinity.Addresses.Exchange[this.chainId]
            ),
          };
        }

        const order = detail.order as Sdk.Infinity.Order;
        const exchange = new Sdk.Infinity.Exchange(this.chainId);

        if (options?.directFillingData) {
          return {
            txs: [
              {
                approvals: approval ? [approval] : [],
                txData: exchange.takeOrdersTx(taker, [
                  {
                    order,
                    tokens: options.directFillingData,
                  },
                ]),
                orderIds: [detail.orderId],
              },
            ],
            success: { [detail.orderId]: true },
          };
        }
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: exchange.takeMultipleOneOrdersTx(taker, [order]),
              orderIds: [detail.orderId],
            },
          ],
          success: { [detail.orderId]: true },
        };
      }
    }

    // TODO: Add Flow router module
    if (details.some(({ kind }) => kind === "flow")) {
      if (options?.relayer) {
        throw new Error("Relayer not supported for Flow orders");
      }

      if (details.length > 1) {
        throw new Error("Flow sweeping is not supported");
      } else {
        if (options?.globalFees?.length) {
          throw new Error("Fees not supported for Flow orders");
        }

        const detail = details[0];

        let approval: FTApproval | undefined;
        if (!isETH(this.chainId, detail.currency)) {
          approval = {
            currency: detail.currency,
            amount: detail.price,
            owner: taker,
            operator: Sdk.Flow.Addresses.Exchange[this.chainId],
            txData: generateNFTApprovalTxData(
              detail.currency,
              taker,
              Sdk.Flow.Addresses.Exchange[this.chainId]
            ),
          };
        }

        const order = detail.order as Sdk.Flow.Order;
        const exchange = new Sdk.Flow.Exchange(this.chainId);

        if (options?.directFillingData) {
          return {
            txs: [
              {
                approvals: approval ? [approval] : [],
                txData: exchange.takeOrdersTx(taker, [
                  {
                    order,
                    tokens: options.directFillingData,
                  },
                ]),
                orderIds: [detail.orderId],
              },
            ],
            success: { [detail.orderId]: true },
          };
        }
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: exchange.takeMultipleOneOrdersTx(taker, [order]),
              orderIds: [detail.orderId],
            },
          ],
          success: { [detail.orderId]: true },
        };
      }
    }

    // TODO: Add Manifold router module
    if (details.some(({ kind }) => kind === "manifold")) {
      if (options?.relayer) {
        throw new Error("Relayer not supported for Manifold orders");
      }

      if (details.length > 1) {
        throw new Error("Manifold sweeping is not supported");
      } else {
        if (options?.globalFees?.length) {
          throw new Error("Fees not supported for Manifold orders");
        }

        const detail = details[0];

        const order = detail.order as Sdk.Manifold.Order;
        const exchange = new Sdk.Manifold.Exchange(this.chainId);

        const amountFilled = Number(detail.amount) ?? 1;
        const orderPrice = bn(order.params.details.initialAmount).mul(amountFilled).toString();

        return {
          txs: [
            {
              approvals: [],
              txData: exchange.fillOrderTx(
                taker,
                Number(order.params.id),
                amountFilled,
                orderPrice,
                options
              ),
              orderIds: [detail.orderId],
            },
          ],
          success: { [detail.orderId]: true },
        };
      }
    }

    if (details.some(({ kind }) => kind === "blur")) {
      if (options?.relayer) {
        throw new Error("Relayer not supported for Blur orders");
      }
    }

    const txs: {
      approvals: FTApproval[];
      txData: TxData;
      orderIds: string[];
    }[] = [];
    const success: { [orderId: string]: boolean } = {};

    // Filling Blur listings is extremely tricky since they explicitly designed
    // their contracts so that it is not possible to fill indirectly (eg. via a
    // router contract). Given these restriction, we might need to use multiple
    // transactions: one for BLUR / OS / LR / X2Y2 orders (what Blur supports),
    // and another one for the rest of the orders (which Blur doesn't support).
    // For orders that Blur supports we use the calldata fetched from their API
    // while for the others we generate the calldata by ourselves. This is only
    // relevant if the orders to fill include a Blur order.

    // Extract any Blur-compatible listings
    const blurCompatibleListings: ListingDetails[] = [];
    if (details.find((d) => d.source === "blur.io")) {
      for (let i = 0; i < details.length; i++) {
        const detail = details[i];
        if (
          detail.contractKind === "erc721" &&
          ["blur.io", "opensea.io", "looksrare.org", "x2y2.io"].includes(detail.source!)
        ) {
          blurCompatibleListings.push(detail);
        }
      }
    }

    // Generate calldata for the above Blur-compatible listings
    if (blurCompatibleListings.length) {
      const url = `${this.options?.orderFetcherBaseUrl}/api/blur-listing`;

      try {
        // We'll have one transaction per contract
        const result: {
          [contract: string]: {
            from: string;
            to: string;
            data: string;
            value: string;
            path: { contract: string; tokenId: string }[];
            errors: { tokenId: string; reason: string }[];
          };
        } = await axios
          .post(
            url,
            {
              taker,
              tokens: blurCompatibleListings.map((d) => ({
                contract: d.contract,
                tokenId: d.tokenId,
                price: d.price,
                isFlagged: d.isFlagged,
              })),
              authToken: options?.blurAuth?.accessToken,
            },
            {
              headers: {
                "X-Api-Key": this.options?.orderFetcherApiKey,
              },
            }
          )
          .then((response) => response.data.calldata);

        for (const [contract, data] of Object.entries(result)) {
          const successfulBlurCompatibleListings: ListingDetails[] = [];
          for (const { tokenId } of data.path) {
            const listing = blurCompatibleListings.find(
              (d) => d.contract === contract && d.tokenId === tokenId
            );
            if (listing) {
              successfulBlurCompatibleListings.push(listing);
            }
          }

          // Expose errors
          for (const { tokenId, reason } of data.errors) {
            if (options?.onRecoverableError) {
              const listing = blurCompatibleListings.find(
                (d) => d.contract === contract && d.tokenId === tokenId
              );
              if (listing) {
                await options.onRecoverableError("order-fetcher-blur-listings", new Error(reason), {
                  orderId: listing.orderId,
                  additionalInfo: { detail: listing, taker, url },
                });
              }
            }
          }

          // If we have at least one Blur listing, we should go ahead with the calldata returned by Blur
          if (successfulBlurCompatibleListings.find((d) => d.source === "blur.io")) {
            // Mark the orders handled by Blur as successful
            const orderIds: string[] = [];
            for (const d of successfulBlurCompatibleListings) {
              success[d.orderId] = true;
              orderIds.push(d.orderId);
            }

            txs.push({
              approvals: [],
              txData: {
                from: data.from,
                to: data.to,
                data: data.data + generateSourceBytes(options?.source),
                value: data.value,
              },
              orderIds,
            });
          }
        }
      } catch (error) {
        if (options?.onRecoverableError) {
          for (const detail of details) {
            if (detail.source === "blur.io" && !success[detail.orderId]) {
              await options.onRecoverableError("order-fetcher-blur-listings", error, {
                orderId: detail.orderId,
                additionalInfo: { detail, taker, url },
              });
            }
          }
        }

        if (!options?.partial) {
          throw new Error(getErrorMessage(error));
        }
      }
    }

    // Check if we still have any Blur listings for which we didn't properly generate calldata
    if (details.find((d) => d.source === "blur.io" && !success[d.orderId])) {
      if (!options?.partial) {
        throw new Error("Could not fetch calldata for all Blur listings");
      }
    }

    // Return early if all listings were covered by Blur
    if (details.every((d) => success[d.orderId])) {
      return {
        txs,
        success,
      };
    }

    // Handle partial seaport orders:
    // - fetch the full order data for each partial order (concurrently)
    // - remove any partial order from the details

    await Promise.all(
      details.map(async (detail, i) => {
        if (detail.kind === "seaport-partial") {
          const order = detail.order as Sdk.SeaportBase.Types.PartialOrder;

          let url = `${this.options?.orderFetcherBaseUrl}/api/listing`;
          url += `?contract=${detail.contract}`;
          url += `&tokenId=${detail.tokenId}`;
          url += order.unitPrice ? `&unitPrice=${order.unitPrice}` : "";
          url += `&orderHash=${order.id}`;
          url += `&taker=${taker}`;
          url += `&chainId=${this.chainId}`;
          url += "&protocolVersion=v1.1";
          url += this.options?.openseaApiKey ? `&openseaApiKey=${this.options.openseaApiKey}` : "";

          try {
            const result = await axios.get(url, {
              headers: {
                "X-Api-Key": this.options?.orderFetcherApiKey,
              },
            });

            // Override the details
            const fullOrder = new Sdk.SeaportV11.Order(this.chainId, result.data.order);
            details[i] = {
              ...detail,
              kind: "seaport",
              order: fullOrder,
            };
          } catch (error) {
            if (options?.onRecoverableError) {
              options.onRecoverableError("order-fetcher-opensea-listing", error, {
                orderId: detail.orderId,
                additionalInfo: {
                  detail,
                  taker,
                  url,
                },
              });
            }

            if (!options?.partial) {
              throw new Error(getErrorMessage(error));
            }
          }
        }
      })
    );

    await Promise.all(
      details.map(async (detail, i) => {
        if (detail.kind === "seaport-v1.4-partial") {
          const order = detail.order as Sdk.SeaportBase.Types.PartialOrder;

          let url = `${this.options?.orderFetcherBaseUrl}/api/listing`;
          url += `?contract=${detail.contract}`;
          url += `&tokenId=${detail.tokenId}`;
          url += order.unitPrice ? `&unitPrice=${order.unitPrice}` : "";
          url += `&orderHash=${order.id}`;
          url += `&taker=${taker}`;
          url += `&chainId=${this.chainId}`;
          url += "&protocolVersion=v1.4";
          url += this.options?.openseaApiKey ? `&openseaApiKey=${this.options.openseaApiKey}` : "";

          try {
            const result = await axios.get(url, {
              headers: {
                "X-Api-Key": this.options?.orderFetcherApiKey,
              },
            });

            // Override the details
            const fullOrder = new Sdk.SeaportV14.Order(this.chainId, result.data.order);
            details[i] = {
              ...detail,
              kind: "seaport-v1.4",
              order: fullOrder,
            };
          } catch (error) {
            if (options?.onRecoverableError) {
              options.onRecoverableError("order-fetcher-opensea-listing", error, {
                orderId: detail.orderId,
                additionalInfo: {
                  detail,
                  taker,
                  url,
                },
              });
            }

            if (!options?.partial) {
              throw new Error(getErrorMessage(error));
            }
          }
        }
      })
    );

    const relayer = options?.relayer ?? taker;

    // If all orders are Seaport, then fill on Seaport directly
    // TODO: Directly fill for other exchanges as well

    if (
      details.every(
        ({ kind, fees, currency, order }) =>
          kind === "seaport" &&
          buyInCurrency === currency &&
          // All orders must have the same currency and conduit
          currency === details[0].currency &&
          (order as Sdk.SeaportV11.Order).params.conduitKey ===
            (details[0].order as Sdk.SeaportV11.Order).params.conduitKey &&
          !fees?.length
      ) &&
      !options?.globalFees?.length &&
      !options?.forceRouter &&
      !options?.relayer
    ) {
      const exchange = new Sdk.SeaportV11.Exchange(this.chainId);

      const conduit = exchange.deriveConduit(
        (details[0].order as Sdk.SeaportV11.Order).params.conduitKey
      );

      let approval: FTApproval | undefined;
      if (!isETH(this.chainId, details[0].currency)) {
        approval = {
          currency: details[0].currency,
          amount: details[0].price,
          owner: taker,
          operator: conduit,
          txData: generateFTApprovalTxData(details[0].currency, taker, conduit),
        };
      }

      if (details.length === 1) {
        const order = details[0].order as Sdk.SeaportV11.Order;
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: await exchange.fillOrderTx(
                taker,
                order,
                order.buildMatching({ amount: details[0].amount }),
                {
                  ...options,
                  ...options?.directFillingData,
                }
              ),
              orderIds: [details[0].orderId],
            },
          ],
          success: { [details[0].orderId]: true },
        };
      } else {
        const orders = details.map((d) => d.order as Sdk.SeaportV11.Order);
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: await exchange.fillOrdersTx(
                taker,
                orders,
                orders.map((order, i) => order.buildMatching({ amount: details[i].amount })),
                {
                  ...options,
                  ...options?.directFillingData,
                }
              ),
              orderIds: details.map((d) => d.orderId),
            },
          ],
          success: Object.fromEntries(details.map((d) => [d.orderId, true])),
        };
      }
    }

    if (
      details.every(
        ({ kind, fees, currency, order }) =>
          kind === "seaport-v1.4" &&
          buyInCurrency === currency &&
          // All orders must have the same currency and conduit
          currency === details[0].currency &&
          (order as Sdk.SeaportV14.Order).params.conduitKey ===
            (details[0].order as Sdk.SeaportV14.Order).params.conduitKey &&
          !fees?.length
      ) &&
      !options?.globalFees?.length &&
      !options?.forceRouter &&
      !options?.relayer
    ) {
      const exchange = new Sdk.SeaportV14.Exchange(this.chainId);

      const conduit = exchange.deriveConduit(
        (details[0].order as Sdk.SeaportV14.Order).params.conduitKey
      );

      let approval: FTApproval | undefined;
      if (!isETH(this.chainId, details[0].currency)) {
        approval = {
          currency: details[0].currency,
          amount: details[0].price,
          owner: taker,
          operator: conduit,
          txData: generateFTApprovalTxData(details[0].currency, taker, conduit),
        };
      }

      if (details.length === 1) {
        const order = details[0].order as Sdk.SeaportV14.Order;
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: await exchange.fillOrderTx(
                taker,
                order,
                order.buildMatching({ amount: details[0].amount }),
                {
                  ...options,
                  ...options?.directFillingData,
                }
              ),
              orderIds: [details[0].orderId],
            },
          ],
          success: { [details[0].orderId]: true },
        };
      } else {
        const orders = details.map((d) => d.order as Sdk.SeaportV14.Order);
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: await exchange.fillOrdersTx(
                taker,
                orders,
                orders.map((order, i) => order.buildMatching({ amount: details[i].amount })),
                {
                  ...options,
                  ...options?.directFillingData,
                }
              ),
              orderIds: details.map((d) => d.orderId),
            },
          ],
          success: Object.fromEntries(details.map((d) => [d.orderId, true])),
        };
      }
    }

    if (
      details.every(
        ({ kind, fees, currency, order }) =>
          kind === "alienswap" &&
          buyInCurrency === currency &&
          // All orders must have the same currency and conduit
          currency === details[0].currency &&
          (order as Sdk.Alienswap.Order).params.conduitKey ===
            (details[0].order as Sdk.Alienswap.Order).params.conduitKey &&
          !fees?.length
      ) &&
      !options?.globalFees?.length &&
      !options?.forceRouter &&
      !options?.relayer
    ) {
      const exchange = new Sdk.Alienswap.Exchange(this.chainId);

      const conduit = exchange.deriveConduit(
        (details[0].order as Sdk.Alienswap.Order).params.conduitKey
      );

      let approval: FTApproval | undefined;
      if (!isETH(this.chainId, details[0].currency)) {
        approval = {
          currency: details[0].currency,
          amount: details[0].price,
          owner: taker,
          operator: conduit,
          txData: generateFTApprovalTxData(details[0].currency, taker, conduit),
        };
      }

      if (details.length === 1) {
        const order = details[0].order as Sdk.Alienswap.Order;
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: await exchange.fillOrderTx(
                taker,
                order,
                order.buildMatching({ amount: details[0].amount }),
                {
                  ...options,
                  ...options?.directFillingData,
                }
              ),
              orderIds: [details[0].orderId],
            },
          ],
          success: { [details[0].orderId]: true },
        };
      } else {
        const orders = details.map((d) => d.order as Sdk.Alienswap.Order);
        return {
          txs: [
            {
              approvals: approval ? [approval] : [],
              txData: await exchange.fillOrdersTx(
                taker,
                orders,
                orders.map((order, i) => order.buildMatching({ amount: details[i].amount })),
                {
                  ...options,
                  ...options?.directFillingData,
                }
              ),
              orderIds: details.map((d) => d.orderId),
            },
          ],
          success: Object.fromEntries(details.map((d) => [d.orderId, true])),
        };
      }
    }

    const getFees = (ownDetails: ListingFillDetails[]) => [
      // Global fees
      ...(options?.globalFees ?? [])
        .filter(
          ({ amount, recipient }) =>
            // Skip zero amounts and/or recipients
            bn(amount).gt(0) && recipient !== AddressZero
        )
        .map(({ recipient, amount }) => ({
          recipient,
          // The fees are averaged over the number of listings to fill
          // TODO: Also take into account the quantity filled for ERC1155
          amount: bn(amount).mul(ownDetails.length).div(details.length),
        })),
      // Local fees
      // TODO: Should not split the local fees among all executions
      ...ownDetails.flatMap(({ fees }) =>
        (fees ?? []).filter(
          ({ amount, recipient }) =>
            // Skip zero amounts and/or recipients
            bn(amount).gt(0) && recipient !== AddressZero
        )
      ),
    ];

    // Keep track of any approvals that might be needed
    const approvals: FTApproval[] = [];

    // Keep track of any FT transfers that need to be performed
    const ftTransferItems: ApprovalProxy.TransferItem[] = [];

    // Keep track of which order ids were handled
    const orderIds: string[] = [];

    // Split all listings by their kind
    const elementErc721Details: ListingDetails[] = [];
    const elementErc721V2Details: ListingDetails[] = [];
    const elementErc1155Details: ListingDetails[] = [];
    const foundationDetails: ListingDetails[] = [];
    const looksRareDetails: ListingDetails[] = [];
    // Only `seaport` and `seaport-v1.4` support non-ETH listings
    const seaportDetails: PerCurrencyListingDetails = {};
    const seaportV14Details: PerCurrencyListingDetails = {};
    const alienswapDetails: PerCurrencyListingDetails = {};
    const sudoswapDetails: ListingDetails[] = [];
    const x2y2Details: ListingDetails[] = [];
    const zeroexV4Erc721Details: ListingDetails[] = [];
    const zeroexV4Erc1155Details: ListingDetails[] = [];
    const zoraDetails: ListingDetails[] = [];
    const nftxDetails: ListingDetails[] = [];
    const raribleDetails: ListingDetails[] = [];
    const superRareDetails: ListingDetails[] = [];

    for (const detail of details) {
      // Skip any listings handled in a previous step
      if (success[detail.orderId]) {
        continue;
      }

      const { kind, contractKind, currency } = detail;

      let detailsRef: ListingDetails[];
      switch (kind) {
        case "element": {
          const order = detail.order as Sdk.Element.Order;
          detailsRef = order.isBatchSignedOrder()
            ? elementErc721V2Details
            : contractKind === "erc721"
            ? elementErc721Details
            : elementErc1155Details;
          break;
        }

        case "foundation":
          detailsRef = foundationDetails;
          break;

        case "looks-rare":
          detailsRef = looksRareDetails;
          break;

        case "seaport":
          if (!seaportDetails[currency]) {
            seaportDetails[currency] = [];
          }
          detailsRef = seaportDetails[currency];
          break;

        case "seaport-v1.4":
          if (!seaportV14Details[currency]) {
            seaportV14Details[currency] = [];
          }
          detailsRef = seaportV14Details[currency];
          break;

        case "alienswap":
          if (!alienswapDetails[currency]) {
            alienswapDetails[currency] = [];
          }
          detailsRef = alienswapDetails[currency];
          break;

        case "sudoswap":
          detailsRef = sudoswapDetails;
          break;

        case "x2y2":
          detailsRef = x2y2Details;
          break;

        case "zeroex-v4":
          detailsRef = contractKind === "erc721" ? zeroexV4Erc721Details : zeroexV4Erc1155Details;
          break;

        case "zora":
          detailsRef = zoraDetails;
          break;

        case "nftx": {
          detailsRef = nftxDetails;
          break;
        }

        case "rarible": {
          detailsRef = raribleDetails;
          break;
        }

        case "superrare": {
          detailsRef = superRareDetails;
          break;
        }

        default:
          continue;
      }

      detailsRef.push(detail);
    }

    // Generate router executions
    let executions: ExecutionInfo[] = [];
    const swapDetails: SwapDetail[] = [];

    // Handle Element ERC721 listings
    if (elementErc721Details.length) {
      const orders = elementErc721Details.map((d) => d.order as Sdk.Element.Order);
      const module = this.contracts.elementModule;

      const fees = getFees(elementErc721Details);
      const price = orders.map((order) => order.getTotalPrice()).reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      const listingParams = {
        fillTo: taker,
        refundTo: relayer,
        revertIfIncomplete: Boolean(!options?.partial),
        amount: price,
      };

      executions.push({
        module: module.address,
        data:
          orders.length === 1
            ? module.interface.encodeFunctionData("acceptETHListingERC721", [
                orders[0].getRaw(),
                orders[0].params,
                listingParams,
                fees,
              ])
            : module.interface.encodeFunctionData("acceptETHListingsERC721", [
                orders.map((order) => order.getRaw()),
                orders.map((order) => order.params),
                listingParams,
                fees,
              ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: module.address,
        refundTo: relayer,
        details: elementErc721Details,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of elementErc721Details) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle Element ERC721 listings V2
    if (elementErc721V2Details.length) {
      const orders = elementErc721V2Details.map((d) => d.order as Sdk.Element.Order);
      const module = this.contracts.elementModule;

      const fees = getFees(elementErc721V2Details);
      const price = orders.map((order) => order.getTotalPrice()).reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      const listingParams = {
        fillTo: taker,
        refundTo: relayer,
        revertIfIncomplete: Boolean(!options?.partial),
        amount: price,
      };

      executions.push({
        module: module.address,
        data:
          orders.length === 1
            ? module.interface.encodeFunctionData("acceptETHListingERC721V2", [
                orders[0].getRaw(),
                listingParams,
                fees,
              ])
            : module.interface.encodeFunctionData("acceptETHListingsERC721V2", [
                orders.map((order) => order.getRaw()),
                listingParams,
                fees,
              ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: module.address,
        refundTo: relayer,
        details: elementErc721V2Details,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of elementErc721V2Details) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle Element ERC1155 listings
    if (elementErc1155Details.length) {
      const orders = elementErc1155Details.map((d) => d.order as Sdk.Element.Order);
      const module = this.contracts.elementModule;

      const fees = getFees(elementErc1155Details);
      const price = orders
        .map((order, i) => order.getTotalPrice(elementErc1155Details[i].amount ?? 1))
        .reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      const listingParams = {
        fillTo: taker,
        refundTo: relayer,
        revertIfIncomplete: Boolean(!options?.partial),
        amount: price,
      };

      executions.push({
        module: module.address,
        data:
          orders.length === 1
            ? module.interface.encodeFunctionData("acceptETHListingERC1155", [
                orders[0].getRaw(),
                orders[0].params,
                elementErc1155Details[0].amount ?? 1,
                listingParams,
                fees,
              ])
            : module.interface.encodeFunctionData("acceptETHListingsERC1155", [
                orders.map((order) => order.getRaw()),
                orders.map((order) => order.params),
                elementErc1155Details.map((d) => d.amount ?? 1),
                listingParams,
                fees,
              ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: module.address,
        refundTo: relayer,
        details: elementErc1155Details,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of elementErc1155Details) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle Foundation listings
    if (foundationDetails.length) {
      const orders = foundationDetails.map((d) => d.order as Sdk.Foundation.Order);
      const module = this.contracts.foundationModule;

      const fees = getFees(foundationDetails);
      const price = orders.map((order) => bn(order.params.price)).reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      executions.push({
        module: module.address,
        data:
          orders.length === 1
            ? module.interface.encodeFunctionData("acceptETHListing", [
                {
                  ...orders[0].params,
                  token: orders[0].params.contract,
                },
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price,
                },
                fees,
              ])
            : module.interface.encodeFunctionData("acceptETHListings", [
                orders.map((order) => ({
                  ...order.params,
                  token: order.params.contract,
                })),
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price,
                },
                fees,
              ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: this.contracts.foundationModule.address,
        refundTo: relayer,
        details: foundationDetails,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of foundationDetails) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle LooksRare listings
    if (looksRareDetails.length) {
      const orders = looksRareDetails.map((d) => d.order as Sdk.LooksRare.Order);
      const module = this.contracts.looksRareModule;

      const fees = getFees(looksRareDetails);
      const price = orders.map((order) => bn(order.params.price)).reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      executions.push({
        module: module.address,
        data:
          orders.length === 1
            ? module.interface.encodeFunctionData("acceptETHListing", [
                orders[0].buildMatching(
                  // For LooksRare, the module acts as the taker proxy
                  module.address
                ),
                orders[0].params,
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price,
                },
                fees,
              ])
            : module.interface.encodeFunctionData("acceptETHListings", [
                orders.map((order) =>
                  order.buildMatching(
                    // For LooksRare, the module acts as the taker proxy
                    module.address
                  )
                ),
                orders.map((order) => order.params),
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price,
                },
                fees,
              ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: module.address,
        refundTo: relayer,
        details: looksRareDetails,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of looksRareDetails) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle Seaport listings
    if (Object.keys(seaportDetails).length) {
      const exchange = new Sdk.SeaportV11.Exchange(this.chainId);
      for (const currency of Object.keys(seaportDetails)) {
        const currencyDetails = seaportDetails[currency];

        const orders = currencyDetails.map((d) => d.order as Sdk.SeaportV11.Order);
        const module = this.contracts.seaportModule;

        const fees = getFees(currencyDetails);
        const price = orders
          .map((order, i) =>
            // Seaport orders can be partially-fillable
            bn(order.getMatchingPrice())
              .mul(currencyDetails[i].amount ?? 1)
              .div(order.getInfo()!.amount)
          )
          .reduce((a, b) => a.add(b), bn(0));
        const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
        const totalPrice = price.add(feeAmount);

        const currencyIsETH = isETH(this.chainId, currency);
        const buyInCurrencyIsETH = isETH(this.chainId, buyInCurrency);
        executions.push({
          module: module.address,
          data:
            orders.length === 1
              ? module.interface.encodeFunctionData(
                  `accept${currencyIsETH ? "ETH" : "ERC20"}Listing`,
                  [
                    {
                      parameters: {
                        ...orders[0].params,
                        totalOriginalConsiderationItems: orders[0].params.consideration.length,
                      },
                      numerator: currencyDetails[0].amount ?? 1,
                      denominator: orders[0].getInfo()!.amount,
                      signature: orders[0].params.signature,
                      extraData: await exchange.getExtraData(orders[0]),
                    },
                    {
                      fillTo: taker,
                      refundTo: relayer,
                      revertIfIncomplete: Boolean(!options?.partial),
                      amount: price,
                      // Only needed for ERC20 listings
                      token: currency,
                    },
                    fees,
                  ]
                )
              : module.interface.encodeFunctionData(
                  `accept${currencyIsETH ? "ETH" : "ERC20"}Listings`,
                  [
                    await Promise.all(
                      orders.map(async (order, i) => {
                        const totalAmount = order.getInfo()!.amount;
                        const filledAmount = currencyDetails[i].amount ?? 1;

                        const orderData = {
                          parameters: {
                            ...order.params,
                            totalOriginalConsiderationItems: order.params.consideration.length,
                          },
                          numerator: filledAmount,
                          denominator: totalAmount,
                          signature: order.params.signature,
                          extraData: await exchange.getExtraData(order),
                        };

                        if (currencyIsETH) {
                          return {
                            order: orderData,
                            price: bn(orders[i].getMatchingPrice())
                              .mul(filledAmount)
                              .div(totalAmount),
                          };
                        } else {
                          return orderData;
                        }
                      })
                    ),
                    {
                      fillTo: taker,
                      refundTo: relayer,
                      revertIfIncomplete: Boolean(!options?.partial),
                      amount: price,
                      // Only needed for ERC20 listings
                      token: currency,
                    },
                    fees,
                  ]
                ),
          value: buyInCurrencyIsETH && currencyIsETH ? totalPrice : 0,
        });

        // Track any possibly required swap
        swapDetails.push({
          tokenIn: buyInCurrency,
          tokenOut: currency,
          tokenOutAmount: totalPrice,
          recipient: module.address,
          refundTo: relayer,
          details: currencyDetails,
          executionIndex: executions.length - 1,
        });

        // Mark the listings as successfully handled
        for (const { orderId } of currencyDetails) {
          success[orderId] = true;
          orderIds.push(orderId);
        }
      }
    }

    // Handle Seaport V1.4 listings
    if (Object.keys(seaportV14Details).length) {
      const exchange = new Sdk.SeaportV14.Exchange(this.chainId);
      for (const currency of Object.keys(seaportV14Details)) {
        const currencyDetails = seaportV14Details[currency];

        const orders = currencyDetails.map((d) => d.order as Sdk.SeaportV14.Order);
        const module = this.contracts.seaportV14Module;

        const fees = getFees(currencyDetails);
        const price = orders
          .map((order, i) =>
            // Seaport orders can be partially-fillable
            bn(order.getMatchingPrice())
              .mul(currencyDetails[i].amount ?? 1)
              .div(order.getInfo()!.amount)
          )
          .reduce((a, b) => a.add(b), bn(0));
        const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
        const totalPrice = price.add(feeAmount);

        const currencyIsETH = isETH(this.chainId, currency);
        const buyInCurrencyIsETH = isETH(this.chainId, buyInCurrency);

        executions.push({
          module: module.address,
          data:
            orders.length === 1
              ? module.interface.encodeFunctionData(
                  `accept${currencyIsETH ? "ETH" : "ERC20"}Listing`,
                  [
                    {
                      parameters: {
                        ...orders[0].params,
                        totalOriginalConsiderationItems: orders[0].params.consideration.length,
                      },
                      numerator: currencyDetails[0].amount ?? 1,
                      denominator: orders[0].getInfo()!.amount,
                      signature: orders[0].params.signature,
                      extraData: await exchange.getExtraData(orders[0], {
                        amount: currencyDetails[0].amount ?? 1,
                      }),
                    },
                    {
                      fillTo: taker,
                      refundTo: relayer,
                      revertIfIncomplete: Boolean(!options?.partial),
                      amount: price,
                      // Only needed for ERC20 listings
                      token: currency,
                    },
                    fees,
                  ]
                )
              : module.interface.encodeFunctionData(
                  `accept${currencyIsETH ? "ETH" : "ERC20"}Listings`,
                  [
                    await Promise.all(
                      orders.map(async (order, i) => {
                        const totalAmount = order.getInfo()!.amount;
                        const filledAmount = currencyDetails[i].amount ?? 1;

                        const orderData = {
                          parameters: {
                            ...order.params,
                            totalOriginalConsiderationItems: order.params.consideration.length,
                          },
                          numerator: filledAmount,
                          denominator: totalAmount,
                          signature: order.params.signature,
                          extraData: await exchange.getExtraData(orders[0], {
                            amount: filledAmount,
                          }),
                        };

                        if (currencyIsETH) {
                          return {
                            order: orderData,
                            price: bn(orders[i].getMatchingPrice())
                              .mul(filledAmount)
                              .div(totalAmount),
                          };
                        } else {
                          return orderData;
                        }
                      })
                    ),
                    {
                      fillTo: taker,
                      refundTo: relayer,
                      revertIfIncomplete: Boolean(!options?.partial),
                      amount: price,
                      // Only needed for ERC20 listings
                      token: currency,
                    },
                    fees,
                  ]
                ),
          value: buyInCurrencyIsETH && currencyIsETH ? totalPrice : 0,
        });

        // Track any possibly required swap
        swapDetails.push({
          tokenIn: buyInCurrency,
          tokenOut: currency,
          tokenOutAmount: totalPrice,
          recipient: module.address,
          refundTo: relayer,
          details: currencyDetails,
          executionIndex: executions.length - 1,
        });

        // Mark the listings as successfully handled
        for (const { orderId } of currencyDetails) {
          success[orderId] = true;
          orderIds.push(orderId);
        }
      }
    }

    // Handle Sudoswap listings
    if (sudoswapDetails.length) {
      const orders = sudoswapDetails.map((d) => d.order as Sdk.Sudoswap.Order);
      const module = this.contracts.sudoswapModule;

      const fees = getFees(sudoswapDetails);
      const price = orders
        .map((order) =>
          bn(
            order.params.extra.prices[
              // Handle multiple listings from the same pool
              orders
                .filter((o) => o.params.pair === order.params.pair)
                .findIndex((o) => o.params.tokenId === order.params.tokenId)
            ]
          )
        )
        .reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      executions.push({
        module: module.address,
        data: module.interface.encodeFunctionData("buyWithETH", [
          sudoswapDetails.map((d) => (d.order as Sdk.Sudoswap.Order).params.pair),
          sudoswapDetails.map((d) => d.tokenId),
          Math.floor(Date.now() / 1000) + 10 * 60,
          {
            fillTo: taker,
            refundTo: relayer,
            revertIfIncomplete: Boolean(!options?.partial),
            amount: price,
          },
          fees,
        ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: module.address,
        refundTo: relayer,
        details: sudoswapDetails,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of sudoswapDetails) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle NFTX listings
    if (nftxDetails.length) {
      const orders = nftxDetails.map((d) => d.order as Sdk.Nftx.Order);
      const module = this.contracts.nftxModule;

      const fees = getFees(nftxDetails);
      const price = orders
        .map((order) =>
          bn(
            order.params.extra.prices[
              // Handle multiple listings from the same pool
              orders
                .filter((o) => o.params.pool === order.params.pool)
                .findIndex((o) => o.params.specificIds?.[0] === order.params.specificIds?.[0])
            ]
          )
        )
        .reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      // Aggregate same-pool orders
      const perPoolOrders: { [pool: string]: Sdk.Nftx.Order[] } = {};
      for (const details of nftxDetails) {
        const order = details.order as Sdk.Nftx.Order;
        if (!perPoolOrders[order.params.pool]) {
          perPoolOrders[order.params.pool] = [];
        }
        perPoolOrders[order.params.pool].push(order);

        // Update the order's price in-place
        order.params.price = order.params.extra.prices[perPoolOrders[order.params.pool].length - 1];
      }

      executions.push({
        module: module.address,
        data: module.interface.encodeFunctionData("buyWithETH", [
          Object.keys(perPoolOrders).map((pool) => ({
            vaultId: perPoolOrders[pool][0].params.vaultId,
            collection: perPoolOrders[pool][0].params.collection,
            specificIds: perPoolOrders[pool].map((o) => o.params.specificIds![0]),
            amount: perPoolOrders[pool].length,
            path: perPoolOrders[pool][0].params.path,
            price: perPoolOrders[pool]
              .map((o) => bn(o.params.price))
              .reduce((a, b) => a.add(b))
              .toString(),
          })),
          {
            fillTo: taker,
            refundTo: relayer,
            revertIfIncomplete: Boolean(!options?.partial),
            amount: price,
          },
          fees,
        ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: module.address,
        refundTo: relayer,
        details: nftxDetails,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of nftxDetails) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle X2Y2 listings
    if (x2y2Details.length) {
      const orders = x2y2Details.map((d) => d.order as Sdk.X2Y2.Order);
      const module = this.contracts.x2y2Module;

      const fees = getFees(x2y2Details);
      // TODO: Only consider successfully-handled orders
      const price = orders.map((order) => bn(order.params.price)).reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      const exchange = new Sdk.X2Y2.Exchange(this.chainId, String(this.options?.x2y2ApiKey));
      if (orders.length === 1) {
        try {
          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData("acceptETHListing", [
              // Fetch X2Y2-signed input
              exchange.contract.interface.decodeFunctionData(
                "run",
                await exchange.fetchInput(
                  // For X2Y2, the module acts as the taker proxy
                  module.address,
                  orders[0],
                  {
                    source: options?.source,
                    tokenId: x2y2Details[0].tokenId,
                  }
                )
              ).input,
              {
                fillTo: taker,
                refundTo: relayer,
                revertIfIncomplete: Boolean(!options?.partial),
                amount: price,
              },
              fees,
            ]),
            value: totalPrice,
          });

          // Track any possibly required swap
          swapDetails.push({
            tokenIn: buyInCurrency,
            tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
            tokenOutAmount: totalPrice,
            recipient: module.address,
            refundTo: relayer,
            details: x2y2Details,
            executionIndex: executions.length - 1,
          });

          // Mark the listing as successfully handled
          success[x2y2Details[0].orderId] = true;
          orderIds.push(x2y2Details[0].orderId);
        } catch (error) {
          if (options?.onRecoverableError) {
            await options.onRecoverableError("x2y2-listing", error, {
              orderId: x2y2Details[0].orderId,
              additionalInfo: { detail: x2y2Details[0], taker },
            });
          }

          if (!options?.partial) {
            throw new Error(getErrorMessage(error));
          }
        }
      } else {
        const inputs: (string | undefined)[] = await Promise.all(
          orders.map(async (order, i) =>
            // Fetch X2Y2-signed input
            exchange
              .fetchInput(
                // For X2Y2, the module acts as the taker proxy
                module.address,
                order,
                {
                  source: options?.source,
                  tokenId: x2y2Details[i].tokenId,
                }
              )
              .then(
                (input) =>
                  // Decode the input from the X2Y2 API response
                  exchange.contract.interface.decodeFunctionData("run", input).input
              )
              .catch(async (error) => {
                if (options?.onRecoverableError) {
                  await options.onRecoverableError("x2y2-listing", error, {
                    orderId: x2y2Details[i].orderId,
                    additionalInfo: { detail: x2y2Details[i], taker },
                  });
                }

                if (!options?.partial) {
                  throw new Error(getErrorMessage(error));
                }
              })
          )
        );

        if (inputs.some(Boolean)) {
          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData("acceptETHListings", [
              inputs.filter(Boolean),
              {
                fillTo: taker,
                refundTo: relayer,
                revertIfIncomplete: Boolean(!options?.partial),
                amount: price,
              },
              fees,
            ]),
            value: totalPrice,
          });

          // Track any possibly required swap
          swapDetails.push({
            tokenIn: buyInCurrency,
            tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
            tokenOutAmount: totalPrice,
            recipient: module.address,
            refundTo: relayer,
            details: x2y2Details,
            executionIndex: executions.length - 1,
          });

          for (let i = 0; i < x2y2Details.length; i++) {
            if (inputs[i]) {
              // Mark the listing as successfully handled
              success[x2y2Details[i].orderId] = true;
              orderIds.push(x2y2Details[i].orderId);
            }
          }
        }
      }
    }

    // Handle ZeroExV4 ERC721 listings
    if (zeroexV4Erc721Details.length) {
      let orders = zeroexV4Erc721Details.map((d) => d.order as Sdk.ZeroExV4.Order);
      const module = this.contracts.zeroExV4Module;

      const unsuccessfulCbIds: string[] = [];
      for (const [i, order] of orders.entries()) {
        const cbId = order.params.cbOrderId;
        if (cbId) {
          // Release the order's signature
          await new Sdk.ZeroExV4.Exchange(this.chainId, String(this.options?.cbApiKey))
            .releaseOrder(taker, order)
            .catch(async (error) => {
              if (options?.onRecoverableError) {
                await options.onRecoverableError("zeroex-v4-erc721-listing", error, {
                  orderId: zeroexV4Erc721Details[i].orderId,
                  additionalInfo: { detail: zeroexV4Erc721Details[i], taker },
                });
              }

              if (!options?.partial) {
                throw new Error(getErrorMessage(error));
              } else {
                unsuccessfulCbIds.push(cbId);
              }
            });
        }
      }
      // Remove any orders that were unsuccessfully released
      if (unsuccessfulCbIds.length) {
        orders = orders.filter((order) => !unsuccessfulCbIds.includes(order.params.cbOrderId!));
      }

      if (orders.length) {
        const fees = getFees(zeroexV4Erc721Details);
        const price = orders
          .map((order) =>
            bn(order.params.erc20TokenAmount).add(
              // For ZeroExV4, the fees are not included in the price
              // TODO: Add order method to get the price including the fees
              order.getFeeAmount()
            )
          )
          .reduce((a, b) => a.add(b), bn(0));
        const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
        const totalPrice = price.add(feeAmount);

        executions.push({
          module: module.address,
          data:
            orders.length === 1
              ? module.interface.encodeFunctionData("acceptETHListingERC721", [
                  orders[0].getRaw(),
                  orders[0].params,
                  {
                    fillTo: taker,
                    refundTo: relayer,
                    revertIfIncomplete: Boolean(!options?.partial),
                    amount: price,
                  },
                  fees,
                ])
              : this.contracts.zeroExV4Module.interface.encodeFunctionData(
                  "acceptETHListingsERC721",
                  [
                    orders.map((order) => order.getRaw()),
                    orders.map((order) => order.params),
                    {
                      fillTo: taker,
                      refundTo: relayer,
                      revertIfIncomplete: Boolean(!options?.partial),
                      amount: price,
                    },
                    fees,
                  ]
                ),
          value: totalPrice,
        });

        // Track any possibly required swap
        swapDetails.push({
          tokenIn: buyInCurrency,
          tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
          tokenOutAmount: totalPrice,
          recipient: module.address,
          refundTo: relayer,
          details: zeroexV4Erc721Details,
          executionIndex: executions.length - 1,
        });

        // Mark the listings as successfully handled
        for (const { orderId } of zeroexV4Erc721Details) {
          success[orderId] = true;
          orderIds.push(orderId);
        }
      }
    }

    // Handle ZeroExV4 ERC1155 listings
    if (zeroexV4Erc1155Details.length) {
      let orders = zeroexV4Erc1155Details.map((d) => d.order as Sdk.ZeroExV4.Order);
      const module = this.contracts.zeroExV4Module;

      const unsuccessfulCbIds: string[] = [];
      for (const [i, order] of orders.entries()) {
        const cbId = order.params.cbOrderId;
        if (cbId) {
          // Release the order's signature
          await new Sdk.ZeroExV4.Exchange(this.chainId, String(this.options?.cbApiKey))
            .releaseOrder(taker, order)
            .catch(async (error) => {
              if (options?.onRecoverableError) {
                await options.onRecoverableError("zeroex-v4-erc1155-listing", error, {
                  orderId: zeroexV4Erc1155Details[i].orderId,
                  additionalInfo: { detail: zeroexV4Erc1155Details[i], taker },
                });
              }

              if (!options?.partial) {
                throw new Error(getErrorMessage(error));
              } else {
                unsuccessfulCbIds.push(cbId);
              }
            });
        }
      }
      // Remove any orders that were unsuccessfully released
      if (unsuccessfulCbIds.length) {
        orders = orders.filter((order) => !unsuccessfulCbIds.includes(order.params.cbOrderId!));
      }

      if (orders.length) {
        const fees = getFees(zeroexV4Erc1155Details);
        const price = orders
          .map((order, i) =>
            bn(order.params.erc20TokenAmount)
              // For ZeroExV4, the fees are not included in the price
              // TODO: Add order method to get the price including the fees
              .add(order.getFeeAmount())
              .mul(zeroexV4Erc1155Details[i].amount ?? 1)
              // Round up
              // TODO: ZeroExV4 ERC1155 orders are partially-fillable
              .add(bn(order.params.nftAmount ?? 1).sub(1))
              .div(order.params.nftAmount ?? 1)
          )
          .reduce((a, b) => a.add(b), bn(0));
        const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
        const totalPrice = price.add(feeAmount);

        executions.push({
          module: module.address,
          data:
            orders.length === 1
              ? module.interface.encodeFunctionData("acceptETHListingERC1155", [
                  orders[0].getRaw(),
                  orders[0].params,
                  zeroexV4Erc1155Details[0].amount ?? 1,
                  {
                    fillTo: taker,
                    refundTo: relayer,
                    revertIfIncomplete: Boolean(!options?.partial),
                    amount: price,
                  },
                  fees,
                ])
              : this.contracts.zeroExV4Module.interface.encodeFunctionData(
                  "acceptETHListingsERC1155",
                  [
                    orders.map((order) => order.getRaw()),
                    orders.map((order) => order.params),
                    zeroexV4Erc1155Details.map((d) => d.amount ?? 1),
                    {
                      fillTo: taker,
                      refundTo: relayer,
                      revertIfIncomplete: Boolean(!options?.partial),
                      amount: price,
                    },
                    fees,
                  ]
                ),
          value: totalPrice,
        });

        // Track any possibly required swap
        swapDetails.push({
          tokenIn: buyInCurrency,
          tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
          tokenOutAmount: totalPrice,
          recipient: module.address,
          refundTo: relayer,
          details: zeroexV4Erc1155Details,
          executionIndex: executions.length - 1,
        });

        // Mark the listings as successfully handled
        for (const { orderId } of zeroexV4Erc1155Details) {
          success[orderId] = true;
          orderIds.push(orderId);
        }
      }
    }

    // Handle Zora listings
    if (zoraDetails.length) {
      const orders = zoraDetails.map((d) => d.order as Sdk.Zora.Order);
      const module = this.contracts.zoraModule;

      const fees = getFees(zoraDetails);
      const price = orders
        .map((order) => bn(order.params.askPrice))
        .reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      executions.push({
        module: module.address,
        data:
          orders.length === 1
            ? module.interface.encodeFunctionData("acceptETHListing", [
                {
                  collection: orders[0].params.tokenContract,
                  tokenId: orders[0].params.tokenId,
                  currency: orders[0].params.askCurrency,
                  amount: orders[0].params.askPrice,
                  finder: taker,
                },
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price,
                },
                fees,
              ])
            : module.interface.encodeFunctionData("acceptETHListings", [
                orders.map((order) => ({
                  collection: order.params.tokenContract,
                  tokenId: order.params.tokenId,
                  currency: order.params.askCurrency,
                  amount: order.params.askPrice,
                  finder: taker,
                })),
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price,
                },
                fees,
              ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: module.address,
        refundTo: relayer,
        details: zoraDetails,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of zoraDetails) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle Rarible listings
    if (raribleDetails.length) {
      const orders = raribleDetails.map((d) => d.order as Sdk.Rarible.Order);
      const module = this.contracts.raribleModule;

      const fees = getFees(raribleDetails);
      const price = orders
        .map((order) => bn(order.params.take.value))
        .reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      executions.push({
        module: module.address,
        data:
          orders.length === 1
            ? module.interface.encodeFunctionData("acceptETHListing", [
                encodeForMatchOrders(orders[0].params),
                orders[0].params.signature,
                encodeForMatchOrders(orders[0].buildMatching(module.address)),
                "0x",
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price,
                },
                fees,
              ])
            : module.interface.encodeFunctionData("acceptETHListings", [
                orders.map((order) => encodeForMatchOrders(order.params)),
                orders.map((order) => order.params.signature),
                orders.map((order) => encodeForMatchOrders(order.buildMatching(module.address))),
                "0x",
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price,
                },
                fees,
              ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: module.address,
        refundTo: relayer,
        details: raribleDetails,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of raribleDetails) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle SuperRare listings
    if (superRareDetails.length) {
      const orders = superRareDetails.map((d) => d.order as Sdk.SuperRare.Order);
      const module = this.contracts.superRareModule;

      const fees = getFees(superRareDetails);
      const price = orders.map((order) => bn(order.params.price)).reduce((a, b) => a.add(b), bn(0));
      const feeAmount = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));
      const totalPrice = price.add(feeAmount);

      executions.push({
        module: module.address,
        data:
          orders.length === 1
            ? module.interface.encodeFunctionData("acceptETHListing", [
                {
                  ...orders[0].params,
                  token: orders[0].params.contract,
                  priceWithFees: bn(orders[0].params.price).add(
                    bn(orders[0].params.price).mul(3).div(100)
                  ),
                },
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price.add(price.mul(3).div(100)),
                },
                fees,
              ])
            : module.interface.encodeFunctionData("acceptETHListings", [
                orders.map((order) => ({
                  ...order.params,
                  token: order.params.contract,
                  priceWithFees: bn(orders[0].params.price).add(
                    bn(orders[0].params.price).mul(3).div(100)
                  ),
                })),
                {
                  fillTo: taker,
                  refundTo: relayer,
                  revertIfIncomplete: Boolean(!options?.partial),
                  amount: price.add(price.mul(3).div(100)),
                },
                fees,
              ]),
        value: totalPrice,
      });

      // Track any possibly required swap
      swapDetails.push({
        tokenIn: buyInCurrency,
        tokenOut: Sdk.Common.Addresses.Eth[this.chainId],
        tokenOutAmount: totalPrice,
        recipient: this.contracts.superRareModule.address,
        refundTo: relayer,
        details: superRareDetails,
        executionIndex: executions.length - 1,
      });

      // Mark the listings as successfully handled
      for (const { orderId } of superRareDetails) {
        success[orderId] = true;
        orderIds.push(orderId);
      }
    }

    // Handle any needed swaps

    const successfulSwapExecutions: ExecutionInfo[] = [];
    const unsuccessfulDependentExecutionIndexes: number[] = [];
    if (swapDetails.length) {
      // Aggregate any swap details for the same token pair
      const aggregatedSwapDetails = swapDetails.reduce((perPoolDetails, current) => {
        const { tokenOut, tokenIn } = current;

        let pool: string;
        if (isETH(this.chainId, tokenIn) && isWETH(this.chainId, tokenOut)) {
          pool = `${tokenIn}:${tokenOut}`;
        } else if (isWETH(this.chainId, tokenIn) && isETH(this.chainId, tokenOut)) {
          pool = `${tokenIn}:${tokenOut}`;
        } else {
          const normalizedTokenIn = isETH(this.chainId, tokenIn)
            ? Sdk.Common.Addresses.Weth[this.chainId]
            : tokenIn;
          const normalizedTokenOut = isETH(this.chainId, tokenOut)
            ? Sdk.Common.Addresses.Weth[this.chainId]
            : tokenOut;
          pool = `${normalizedTokenIn}:${normalizedTokenOut}`;
        }

        if (!perPoolDetails[pool]) {
          perPoolDetails[pool] = [];
        }
        perPoolDetails[pool].push(current);

        return perPoolDetails;
      }, {} as PerPoolSwapDetails);

      // For each token pair, generate a swap execution
      for (const swapDetails of Object.values(aggregatedSwapDetails)) {
        // All swap details for this pool will have the same out and in tokens
        const { tokenIn, tokenOut } = swapDetails[0];

        const transfers = swapDetails.map((s) => {
          return {
            recipient: s.recipient,
            amount: s.tokenOutAmount,
            // Unwrap if the out token is ETH
            toETH: isETH(this.chainId, s.tokenOut),
          };
        });

        const totalAmountOut = swapDetails
          .map((order) => bn(order.tokenOutAmount))
          .reduce((a, b) => a.add(b), bn(0));

        try {
          // Only generate a swap if the in token is different from the out token
          let inAmount = totalAmountOut.toString();
          if (tokenIn !== tokenOut) {
            const { executions: swapExecutions, amountIn } = await generateSwapExecutions(
              this.chainId,
              this.provider,
              tokenIn,
              tokenOut,
              totalAmountOut,
              {
                swapModule: this.contracts.swapModule,
                transfers,
                refundTo: relayer,
              }
            );

            successfulSwapExecutions.push(...swapExecutions);

            // Update the in amount
            inAmount = amountIn.toString();
          }

          if (!isETH(this.chainId, tokenIn)) {
            const conduitController = new Sdk.SeaportBase.ConduitController(this.chainId);
            const conduit = conduitController.deriveConduit(
              Sdk.SeaportBase.Addresses.ReservoirConduitKey[this.chainId]
            );

            approvals.push({
              currency: tokenIn,
              amount: inAmount,
              owner: relayer,
              operator: conduit,
              txData: generateFTApprovalTxData(tokenIn, relayer, conduit),
            });

            if (tokenIn !== tokenOut) {
              // The swap module will take care of handling additional transfers
              ftTransferItems.push({
                items: [
                  {
                    itemType: ApprovalProxy.ItemType.ERC20,
                    token: tokenIn,
                    identifier: 0,
                    amount: inAmount,
                  },
                ],
                recipient: this.contracts.swapModule.address,
              });
            } else {
              // We need to split the permit items based on the individual transfers
              ftTransferItems.push(
                ...transfers.map((t) => ({
                  items: transfers.map((t) => ({
                    itemType: ApprovalProxy.ItemType.ERC20,
                    token: tokenIn,
                    identifier: 0,
                    amount: t.amount,
                  })),
                  recipient: t.recipient,
                }))
              );
            }
          }
        } catch (error) {
          // Since the swap execution generation failed, we should also skip the associated fill executions
          await Promise.all(
            swapDetails.map(async (s) => {
              for (const detail of s.details) {
                success[detail.orderId] = false;
                txs.forEach((tx) => {
                  tx.orderIds = tx.orderIds.filter((orderId) => orderId !== detail.orderId);
                });

                if (options?.onRecoverableError) {
                  await options.onRecoverableError("swap-generation", error, {
                    orderId: detail.orderId,
                    additionalInfo: { detail, taker },
                  });
                }
              }
              unsuccessfulDependentExecutionIndexes.push(s.executionIndex);
            })
          );

          if (!options?.partial) {
            throw new Error(getErrorMessage(error));
          }
        }
      }
    }

    // Filter out any executions that depend on failed swaps
    executions = executions.filter((_, i) => !unsuccessfulDependentExecutionIndexes.includes(i));

    if (executions.length) {
      // Prepend any swap executions
      executions = [...successfulSwapExecutions, ...executions];

      // If the buy-in currency is not ETH then we won't need any `value` fields
      if (buyInCurrency !== Sdk.Common.Addresses.Eth[this.chainId]) {
        executions.forEach((e) => {
          e.value = 0;
        });
      }

      txs.push({
        approvals,
        txData: {
          from: relayer,
          ...(ftTransferItems.length
            ? {
                to: this.contracts.approvalProxy.address,
                data: this.contracts.approvalProxy.interface.encodeFunctionData(
                  "bulkTransferWithExecute",
                  [
                    ftTransferItems,
                    executions,
                    Sdk.SeaportBase.Addresses.ReservoirConduitKey[this.chainId],
                  ]
                ),
              }
            : {
                to: this.contracts.router.address,
                data:
                  this.contracts.router.interface.encodeFunctionData("execute", [executions]) +
                  generateSourceBytes(options?.source),
                value: executions
                  .map((e) => bn(e.value))
                  .reduce((a, b) => a.add(b))
                  .toHexString(),
              }),
        },
        orderIds,
      });
    }

    if (!txs.length) {
      throw new Error("Could not fill any of the requested orders");
    }

    return {
      txs,
      success,
    };
  }

  // Fill multiple bids in a single transaction
  public async fillBidsTx(
    details: BidDetails[],
    taker: string,
    options?: {
      // Fill source for attribution
      source?: string;
      // Skip any errors (either off-chain or on-chain)
      partial?: boolean;
      // Force filling via the approval proxy
      forceApprovalProxy?: boolean;
      // Callback for handling recoverable errors
      onRecoverableError?: (
        kind: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        error: any,
        data: {
          orderId: string;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          additionalInfo: any;
        }
      ) => Promise<void>;
    }
  ): Promise<FillBidsResult> {
    // Assume the bid details are consistent with the underlying order object

    // When filling a single order in partial mode, propagate any errors back directly
    if (options?.partial && details.length === 1) {
      options.partial = false;
    }

    // CASE 1
    // Handle exchanges which don't have a router module implemented by filling directly

    // TODO: Add Universe router module
    if (details.some(({ kind }) => kind === "universe")) {
      if (details.length > 1) {
        throw new Error("Universe multi-selling is not supported");
      } else {
        const detail = details[0];

        // Approve Universe's Exchange contract
        const approval = {
          contract: detail.contract,
          owner: taker,
          operator: Sdk.Universe.Addresses.Exchange[this.chainId],
          txData: generateNFTApprovalTxData(
            detail.contract,
            taker,
            Sdk.Universe.Addresses.Exchange[this.chainId]
          ),
        };

        const order = detail.order as Sdk.Universe.Order;
        const exchange = new Sdk.Universe.Exchange(this.chainId);
        return {
          txData: await exchange.fillOrderTx(taker, order, {
            amount: Number(detail.amount ?? 1),
            source: options?.source,
          }),
          success: [true],
          approvals: [approval],
        };
      }
    }

    // TODO: Add Forward router module
    if (details.some(({ kind }) => kind === "forward")) {
      if (details.length > 1) {
        throw new Error("Forward multi-selling is not supported");
      } else {
        const detail = details[0];

        // Approve Forward's Exchange contract
        const approval = {
          contract: detail.contract,
          owner: taker,
          operator: Sdk.Forward.Addresses.Exchange[this.chainId],
          txData: generateNFTApprovalTxData(
            detail.contract,
            taker,
            Sdk.Forward.Addresses.Exchange[this.chainId]
          ),
        };

        const order = detail.order as Sdk.Forward.Order;
        const matchParams = order.buildMatching({
          tokenId: detail.tokenId,
          amount: detail.amount ?? 1,
          ...(detail.extraArgs ?? {}),
        });

        const exchange = new Sdk.Forward.Exchange(this.chainId);
        return {
          txData: exchange.fillOrderTx(taker, order, matchParams, {
            source: options?.source,
          }),
          success: [true],
          approvals: [approval],
        };
      }
    }

    // CASE 2
    // Handle exchanges which do have a router module implemented by filling through the router

    // Step 1
    // Handle approvals and permits

    // Keep track of any approvals that might be needed
    const approvals: NFTApproval[] = [];

    // Keep track of any NFT transfers that need to be performed
    const nftTransferItems: ApprovalProxy.TransferItem[] = [];

    for (let i = 0; i < details.length; i++) {
      const detail = details[i];

      const contract = detail.contract;
      const owner = taker;
      const operator = new Sdk.SeaportV11.Exchange(this.chainId).deriveConduit(
        Sdk.SeaportBase.Addresses.ReservoirConduitKey[this.chainId]
      );

      // Generate approval
      approvals.push({
        contract,
        owner,
        operator,
        txData: generateNFTApprovalTxData(contract, owner, operator),
      });

      // Generate permit item
      let module: Contract;
      switch (detail.kind) {
        case "looks-rare": {
          module = this.contracts.looksRareModule;
          break;
        }

        case "seaport":
        case "seaport-partial": {
          module = this.contracts.seaportModule;
          break;
        }

        case "seaport-v1.4":
        case "seaport-v1.4-partial": {
          module = this.contracts.seaportV14Module;
          break;
        }

        case "alienswap": {
          module = this.contracts.alienswapModule;
          break;
        }

        case "sudoswap": {
          module = this.contracts.sudoswapModule;
          break;
        }

        case "nftx": {
          module = this.contracts.nftxModule;
          break;
        }

        case "x2y2": {
          module = this.contracts.x2y2Module;
          break;
        }

        case "zeroex-v4": {
          module = this.contracts.zeroExV4Module;
          break;
        }

        case "element": {
          module = this.contracts.elementModule;
          break;
        }

        case "rarible": {
          module = this.contracts.raribleModule;
          break;
        }

        default: {
          throw new Error("Unreachable");
        }
      }

      nftTransferItems.push({
        items: [
          {
            itemType:
              detail.contractKind === "erc721"
                ? ApprovalProxy.ItemType.ERC721
                : ApprovalProxy.ItemType.ERC1155,
            token: detail.contract,
            identifier: detail.tokenId,
            amount: detail.amount ?? 1,
          },
        ],
        recipient: module.address,
      });
    }

    // Step 2
    // Handle calldata generation

    // Generate router executions
    const executions: ExecutionInfo[] = [];
    const success: boolean[] = details.map(() => false);

    for (let i = 0; i < details.length; i++) {
      const detail = details[i];

      switch (detail.kind) {
        case "looks-rare": {
          const order = detail.order as Sdk.LooksRare.Order;
          const module = this.contracts.looksRareModule;

          const matchParams = order.buildMatching(
            // For LooksRare, the module acts as the taker proxy
            module.address,
            {
              tokenId: detail.tokenId,
              ...(detail.extraArgs || {}),
            }
          );

          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData(
              detail.contractKind === "erc721" ? "acceptERC721Offer" : "acceptERC1155Offer",
              [
                matchParams,
                order.params,
                {
                  fillTo: taker,
                  refundTo: taker,
                  revertIfIncomplete: Boolean(!options?.partial),
                },
                detail.fees ?? [],
              ]
            ),
            value: 0,
          });

          success[i] = true;

          break;
        }

        case "seaport": {
          const order = detail.order as Sdk.SeaportV11.Order;
          const module = this.contracts.seaportModule;

          const matchParams = order.buildMatching({
            tokenId: detail.tokenId,
            amount: detail.amount ?? 1,
            ...(detail.extraArgs ?? {}),
          });

          const exchange = new Sdk.SeaportV11.Exchange(this.chainId);
          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData(
              detail.contractKind === "erc721" ? "acceptERC721Offer" : "acceptERC1155Offer",
              [
                {
                  parameters: {
                    ...order.params,
                    totalOriginalConsiderationItems: order.params.consideration.length,
                  },
                  numerator: matchParams.amount ?? 1,
                  denominator: order.getInfo()!.amount,
                  signature: order.params.signature,
                  extraData: await exchange.getExtraData(order),
                },
                matchParams.criteriaResolvers ?? [],
                {
                  fillTo: taker,
                  refundTo: taker,
                  revertIfIncomplete: Boolean(!options?.partial),
                },
                detail.fees ?? [],
              ]
            ),
            value: 0,
          });

          success[i] = true;

          break;
        }

        case "seaport-partial": {
          const order = detail.order as Sdk.SeaportBase.Types.PartialOrder;
          const module = this.contracts.seaportModule;

          let url = `${this.options?.orderFetcherBaseUrl}/api/offer`;
          url += `?orderHash=${order.id}`;
          url += `&contract=${order.contract}`;
          url += `&tokenId=${order.tokenId}`;
          url += `&taker=${detail.owner ?? taker}`;
          url += `&chainId=${this.chainId}`;
          url += "&protocolVersion=v1.1";
          url += order.unitPrice ? `&unitPrice=${order.unitPrice}` : "";
          url += this.options?.openseaApiKey ? `&openseaApiKey=${this.options.openseaApiKey}` : "";

          try {
            const result = await axios.get(url, {
              headers: {
                "X-Api-Key": this.options?.orderFetcherApiKey,
              },
            });

            const fullOrder = new Sdk.SeaportV11.Order(this.chainId, result.data.order);
            executions.push({
              module: module.address,
              data: module.interface.encodeFunctionData(
                detail.contractKind === "erc721" ? "acceptERC721Offer" : "acceptERC1155Offer",
                [
                  {
                    parameters: {
                      ...fullOrder.params,
                      totalOriginalConsiderationItems: fullOrder.params.consideration.length,
                    },
                    numerator: detail.amount ?? 1,
                    denominator: fullOrder.getInfo()!.amount,
                    signature: fullOrder.params.signature,
                    extraData: result.data.extraData,
                  },
                  result.data.criteriaResolvers ?? [],
                  {
                    fillTo: taker,
                    refundTo: taker,
                    revertIfIncomplete: Boolean(!options?.partial),
                  },
                  detail.fees ?? [],
                ]
              ),
              value: 0,
            });

            success[i] = true;
          } catch (error) {
            if (options?.onRecoverableError) {
              options.onRecoverableError("order-fetcher-opensea-offer", error, {
                orderId: detail.orderId,
                additionalInfo: {
                  detail,
                  taker,
                  url,
                },
              });
            }

            if (!options?.partial) {
              throw new Error(getErrorMessage(error));
            }
          }

          break;
        }

        case "seaport-v1.4": {
          const order = detail.order as Sdk.SeaportV14.Order;
          const module = this.contracts.seaportV14Module;

          const matchParams = order.buildMatching({
            tokenId: detail.tokenId,
            amount: detail.amount ?? 1,
            ...(detail.extraArgs ?? {}),
          });

          const exchange = new Sdk.SeaportV14.Exchange(this.chainId);
          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData(
              detail.contractKind === "erc721" ? "acceptERC721Offer" : "acceptERC1155Offer",
              [
                {
                  parameters: {
                    ...order.params,
                    totalOriginalConsiderationItems: order.params.consideration.length,
                  },
                  numerator: matchParams.amount ?? 1,
                  denominator: order.getInfo()!.amount,
                  signature: order.params.signature,
                  extraData: await exchange.getExtraData(order, matchParams),
                },
                matchParams.criteriaResolvers ?? [],
                {
                  fillTo: taker,
                  refundTo: taker,
                  revertIfIncomplete: Boolean(!options?.partial),
                },
                detail.fees ?? [],
              ]
            ),
            value: 0,
          });

          success[i] = true;

          break;
        }

        case "seaport-v1.4-partial": {
          const order = detail.order as Sdk.SeaportBase.Types.PartialOrder;
          const module = this.contracts.seaportV14Module;

          let url = `${this.options?.orderFetcherBaseUrl}/api/offer`;
          url += `?orderHash=${order.id}`;
          url += `&contract=${order.contract}`;
          url += `&tokenId=${order.tokenId}`;
          url += `&taker=${detail.isProtected ? taker : detail.owner ?? taker}`;
          url += `&chainId=${this.chainId}`;
          url += "&protocolVersion=v1.4";
          url += order.unitPrice ? `&unitPrice=${order.unitPrice}` : "";
          url += detail.isProtected ? "&isProtected=true" : "";
          url += this.options?.openseaApiKey ? `&openseaApiKey=${this.options.openseaApiKey}` : "";

          try {
            const result = await axios.get(url, {
              headers: {
                "X-Api-Key": this.options?.orderFetcherApiKey,
              },
            });

            if (result.data.calldata) {
              const contract = detail.contract;
              const owner = taker;
              const operator = new Sdk.SeaportBase.ConduitController(this.chainId).deriveConduit(
                Sdk.SeaportBase.Addresses.OpenseaConduitKey[this.chainId]
              );

              // Fill directly
              return {
                txData: {
                  from: taker,
                  to: Sdk.SeaportV14.Addresses.Exchange[this.chainId],
                  data: result.data.calldata + generateSourceBytes(options?.source),
                },
                success: [true],
                approvals: [
                  {
                    contract,
                    owner,
                    operator,
                    txData: generateNFTApprovalTxData(contract, owner, operator),
                  },
                ],
              };
            }

            const fullOrder = new Sdk.SeaportV14.Order(this.chainId, result.data.order);
            executions.push({
              module: module.address,
              data: module.interface.encodeFunctionData(
                detail.contractKind === "erc721" ? "acceptERC721Offer" : "acceptERC1155Offer",
                [
                  {
                    parameters: {
                      ...fullOrder.params,
                      totalOriginalConsiderationItems: fullOrder.params.consideration.length,
                    },
                    numerator: detail.amount ?? 1,
                    denominator: fullOrder.getInfo()!.amount,
                    signature: fullOrder.params.signature,
                    extraData: result.data.extraData,
                  },
                  result.data.criteriaResolvers ?? [],
                  {
                    fillTo: taker,
                    refundTo: taker,
                    revertIfIncomplete: Boolean(!options?.partial),
                  },
                  detail.fees ?? [],
                ]
              ),
              value: 0,
            });

            success[i] = true;
          } catch (error) {
            if (options?.onRecoverableError) {
              options.onRecoverableError("order-fetcher-opensea-offer", error, {
                orderId: detail.orderId,
                additionalInfo: {
                  detail,
                  taker,
                  url,
                },
              });
            }

            if (!options?.partial) {
              throw new Error(getErrorMessage(error));
            }
          }

          break;
        }

        case "alienswap": {
          const order = detail.order as Sdk.Alienswap.Order;
          const module = this.contracts.alienswapModule;

          const matchParams = order.buildMatching({
            tokenId: detail.tokenId,
            amount: detail.amount ?? 1,
            ...(detail.extraArgs ?? {}),
          });

          const exchange = new Sdk.Alienswap.Exchange(this.chainId);
          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData(
              detail.contractKind === "erc721" ? "acceptERC721Offer" : "acceptERC1155Offer",
              [
                {
                  parameters: {
                    ...order.params,
                    totalOriginalConsiderationItems: order.params.consideration.length,
                  },
                  numerator: matchParams.amount ?? 1,
                  denominator: order.getInfo()!.amount,
                  signature: order.params.signature,
                  extraData: await exchange.getExtraData(order),
                },
                matchParams.criteriaResolvers ?? [],
                {
                  fillTo: taker,
                  refundTo: taker,
                  revertIfIncomplete: Boolean(!options?.partial),
                },
                detail.fees ?? [],
              ]
            ),
            value: 0,
          });

          success[i] = true;

          break;
        }

        case "sudoswap": {
          const order = detail.order as Sdk.Sudoswap.Order;
          const module = this.contracts.sudoswapModule;

          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData("sell", [
              order.params.pair,
              detail.tokenId,
              bn(order.params.extra.prices[0]).sub(
                // Take into account the protocol fee of 0.5%
                bn(order.params.extra.prices[0]).mul(50).div(10000)
              ),
              Math.floor(Date.now() / 1000) + 10 * 60,
              {
                fillTo: taker,
                refundTo: taker,
                revertIfIncomplete: Boolean(!options?.partial),
              },
              detail.fees ?? [],
            ]),
            value: 0,
          });

          success[i] = true;

          break;
        }

        case "x2y2": {
          const order = detail.order as Sdk.X2Y2.Order;
          const module = this.contracts.x2y2Module;

          try {
            const exchange = new Sdk.X2Y2.Exchange(this.chainId, String(this.options?.x2y2ApiKey));
            executions.push({
              module: module.address,
              data: module.interface.encodeFunctionData(
                detail.contractKind === "erc721" ? "acceptERC721Offer" : "acceptERC1155Offer",
                [
                  exchange.contract.interface.decodeFunctionData(
                    "run",
                    await exchange.fetchInput(
                      // For X2Y2, the module acts as the taker proxy
                      module.address,
                      order,
                      {
                        tokenId: detail.tokenId,
                        source: options?.source,
                      }
                    )
                  ).input,
                  {
                    fillTo: taker,
                    refundTo: taker,
                    revertIfIncomplete: Boolean(!options?.partial),
                  },
                  detail.fees ?? [],
                ]
              ),
              value: 0,
            });

            success[i] = true;
          } catch (error) {
            if (options?.onRecoverableError) {
              options.onRecoverableError("x2y2-offer", error, {
                orderId: detail.orderId,
                additionalInfo: {
                  detail,
                  taker,
                },
              });
            }

            if (!options?.partial) {
              throw new Error(getErrorMessage(error));
            }
          }

          break;
        }

        case "zeroex-v4": {
          const order = detail.order as Sdk.ZeroExV4.Order;
          const module = this.contracts.zeroExV4Module;

          try {
            // Retrieve the order's signature
            if (order.params.cbOrderId) {
              await new Sdk.ZeroExV4.Exchange(
                this.chainId,
                String(this.options?.cbApiKey)
              ).releaseOrder(taker, order);
            }

            if (detail.contractKind === "erc721") {
              executions.push({
                module: module.address,
                data: module.interface.encodeFunctionData("acceptERC721Offer", [
                  order.getRaw(),
                  order.params,
                  {
                    fillTo: taker,
                    refundTo: taker,
                    revertIfIncomplete: Boolean(!options?.partial),
                  },
                  detail.tokenId,
                  detail.fees ?? [],
                ]),
                value: 0,
              });
            } else {
              executions.push({
                module: module.address,
                data: module.interface.encodeFunctionData("acceptERC1155Offer", [
                  order.getRaw(),
                  order.params,
                  detail.amount ?? 1,
                  {
                    fillTo: taker,
                    refundTo: taker,
                    revertIfIncomplete: Boolean(!options?.partial),
                  },
                  detail.tokenId,
                  detail.fees ?? [],
                ]),
                value: 0,
              });
            }

            success[i] = true;
          } catch (error) {
            if (options?.onRecoverableError) {
              options.onRecoverableError("zeroex-v4-offer", error, {
                orderId: detail.orderId,
                additionalInfo: {
                  detail,
                  taker,
                },
              });
            }

            if (!options?.partial) {
              throw new Error(getErrorMessage(error));
            }
          }

          break;
        }

        case "element": {
          const order = detail.order as Sdk.Element.Order;
          const module = this.contracts.elementModule;

          if (detail.contractKind === "erc721") {
            executions.push({
              module: module.address,
              data: module.interface.encodeFunctionData("acceptERC721Offer", [
                order.getRaw(),
                order.params,
                {
                  fillTo: taker,
                  refundTo: taker,
                  revertIfIncomplete: Boolean(!options?.partial),
                },
                detail.tokenId,
                detail.fees ?? [],
              ]),
              value: 0,
            });
          } else {
            executions.push({
              module: module.address,
              data: module.interface.encodeFunctionData("acceptERC1155Offer", [
                order.getRaw(),
                order.params,
                detail.amount ?? 1,
                {
                  fillTo: taker,
                  refundTo: taker,
                  revertIfIncomplete: Boolean(!options?.partial),
                },
                detail.tokenId,
                detail.fees ?? [],
              ]),
              value: 0,
            });
          }

          success[i] = true;

          break;
        }

        case "nftx": {
          const order = detail.order as Sdk.Nftx.Order;
          const module = this.contracts.nftxModule;

          const tokenId = detail.tokenId;
          order.params.specificIds = [tokenId];

          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData("sell", [
              [order.params],
              {
                fillTo: taker,
                refundTo: taker,
                revertIfIncomplete: Boolean(!options?.partial),
              },
              detail.fees ?? [],
            ]),
            value: 0,
          });

          success[i] = true;

          break;
        }

        case "rarible": {
          const order = detail.order as Sdk.Rarible.Order;
          const module = this.contracts.raribleModule;

          const matchParams = order.buildMatching(module.address, {
            tokenId: detail.tokenId,
            assetClass: detail.contractKind.toUpperCase(),
            ...(detail.extraArgs || {}),
          });

          executions.push({
            module: module.address,
            data: module.interface.encodeFunctionData(
              detail.contractKind === "erc721" ? "acceptERC721Offer" : "acceptERC1155Offer",
              [
                encodeForMatchOrders(order.params),
                order.params.signature,
                encodeForMatchOrders(matchParams),
                "0x",
                {
                  fillTo: taker,
                  refundTo: taker,
                  revertIfIncomplete: Boolean(!options?.partial),
                },
                detail.fees ?? [],
              ]
            ),
            value: 0,
          });

          success[i] = true;

          break;
        }

        default: {
          throw new Error("Unreachable");
        }
      }
    }

    if (!executions.length) {
      throw new Error("Could not fill any of the requested orders");
    }

    if (executions.length === 1 && !options?.forceApprovalProxy) {
      const routerLevelTxData = this.contracts.router.interface.encodeFunctionData("execute", [
        executions,
      ]);

      // Use the on-received ERC721/ERC1155 hooks for approval-less bid filling
      const detail = details[success.findIndex(Boolean)];
      if (detail.contractKind === "erc721") {
        return {
          txData: {
            from: taker,
            to: detail.contract,
            data:
              new Interface(ERC721Abi).encodeFunctionData(
                "safeTransferFrom(address,address,uint256,bytes)",
                [taker, executions[0].module, detail.tokenId, routerLevelTxData]
              ) + generateSourceBytes(options?.source),
          },
          success,
          approvals: [],
        };
      } else {
        return {
          txData: {
            from: taker,
            to: detail.contract,
            data:
              new Interface(ERC1155Abi).encodeFunctionData(
                "safeTransferFrom(address,address,uint256,uint256,bytes)",
                [taker, executions[0].module, detail.tokenId, detail.amount ?? 1, routerLevelTxData]
              ) + generateSourceBytes(options?.source),
          },
          success,
          approvals: [],
        };
      }
    } else {
      return {
        txData: {
          from: taker,
          to: this.contracts.approvalProxy.address,
          data: this.contracts.approvalProxy.interface.encodeFunctionData(
            "bulkTransferWithExecute",
            [
              nftTransferItems,
              executions,
              Sdk.SeaportBase.Addresses.ReservoirConduitKey[this.chainId],
            ]
          ),
        },
        success,
        // Ensure approvals are unique
        approvals: uniqBy(
          approvals.filter((_, i) => success[i]),
          ({ txData: { from, to, data } }) => `${from}-${to}-${data}`
        ),
      };
    }
  }
}
