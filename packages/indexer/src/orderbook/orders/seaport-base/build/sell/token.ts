import { redb } from "@/common/db";
import { toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import * as utils from "@/orderbook/orders/seaport/build/utils";
import { IBuilderConstructor } from "@reservoir0x/sdk/src/seaport-base/builders/base"; // TODO: @Joey src --> dist
import { IOrder } from "@reservoir0x/sdk/src/seaport-base/order";

interface BuildOrderOptions extends utils.BaseOrderBuildOptions {
  tokenId: string;
}

export const build = async (
  options: BuildOrderOptions,
  builderConstructor: IBuilderConstructor<IOrder>
) => {
  const collectionResult = await redb.oneOrNone(
    `
      SELECT
        tokens.collection_id
      FROM tokens
      WHERE tokens.contract = $/contract/
        AND tokens.token_id = $/tokenId/
    `,
    {
      contract: toBuffer(options.contract!),
      tokenId: options.tokenId,
    }
  );
  if (!collectionResult) {
    throw new Error("Could not retrieve token's collection");
  }

  const buildInfo = await utils.getBuildInfo(options, collectionResult.collection_id, "sell");

  //   const builder: BaseBuilder = new Sdk.Seaport.Builders.SingleToken(config.chainId);

  const builder = new builderConstructor(config.chainId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (buildInfo.params as any).tokenId = options.tokenId;

  return builder.build(buildInfo.params);
};
