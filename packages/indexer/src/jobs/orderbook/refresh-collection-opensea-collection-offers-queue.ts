/* eslint-disable @typescript-eslint/no-explicit-any */

import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { logger } from "@/common/logger";
import { acquireLock, redis, releaseLock } from "@/common/redis";
import { config } from "@/config/index";
import { redb } from "@/common/db";
import { parseProtocolData } from "@/websockets/opensea";
import * as orderbookOrders from "@/jobs/orderbook/orders-queue";
import { OpenseaOrderParams } from "@/orderbook/orders/seaport";
import { getSupportedChainName } from "@/websockets/opensea/utils";
import axios from "axios";
import { fromBuffer } from "@/common/utils";

const QUEUE_NAME = "refresh-collection-opensea-collection-offers-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { collection } = job.data;

      if (await acquireLock(getLockName(collection), 60)) {
        const collectionResult = await redb.oneOrNone(
          `
          SELECT
            collections.contract,
            collections.slug
          FROM collections
          WHERE collections.id = $/collection/
        `,
          {
            collection,
          }
        );

        if (collectionResult) {
          try {
            const fetchCollectionOffersResponse = await axios.get(
              `https://${
                config.chainId === 5 ? "testnets-api" : "api"
              }.opensea.io/api/v2/offers/collection/${collectionResult.slug}`,
              {
                headers:
                  config.chainId === 5
                    ? {
                        "Content-Type": "application/json",
                      }
                    : {
                        "Content-Type": "application/json",
                        "X-Api-Key": config.openSeaApiKey,
                      },
              }
            );

            const collectionOffers = fetchCollectionOffersResponse.data.offers;

            if (collectionOffers.length) {
              logger.info(
                QUEUE_NAME,
                `collectionOffers. collectionOffersCount=${collectionOffers.length}`
              );

              for (const collectionOffer of collectionOffers) {
                if (getSupportedChainName() === collectionOffer.chain) {
                  const openSeaOrderParams = {
                    kind: "contract-wide",
                    side: "buy",
                    hash: collectionOffer.order_hash,
                    contract: fromBuffer(collectionResult.contract),
                    collectionSlug: collectionResult.slug,
                  } as OpenseaOrderParams;

                  if (openSeaOrderParams) {
                    const protocolData = parseProtocolData(collectionOffer);

                    if (protocolData) {
                      const orderInfo = {
                        kind: protocolData.kind,
                        info: {
                          orderParams: protocolData.order.params,
                          metadata: {
                            originatedAt: Math.floor(Date.now() / 1000),
                          },
                          isOpenSea: true,
                          openSeaOrderParams,
                        },
                        relayToArweave: false,
                        validateBidValue: true,
                      } as any;

                      await orderbookOrders.addToQueue([orderInfo]);
                    }
                  }
                }
              }
            }
          } catch (error) {
            logger.error(
              QUEUE_NAME,
              `fetchCollectionOffers failed. job=${JSON.stringify(job)}, error=${error}`
            );

            if ((error as any).response.status === 429) {
              await addToQueue(collection, 5000);
            }
          }
        }

        await releaseLock(getLockName(collection));
      }
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("failed", async (job) => {
    logger.error(QUEUE_NAME, `Worker failed: ${JSON.stringify(job)}`);
  });

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const getLockName = (collection: string) => {
  return `${QUEUE_NAME}:${collection}-lock`;
};

export const addToQueue = async (collection: string, delay = 0) => {
  await queue.add(
    randomUUID(),
    { collection },
    {
      delay,
    }
  );
};
