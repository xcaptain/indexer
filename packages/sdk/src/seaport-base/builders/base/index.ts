import { BigNumberish } from "@ethersproject/bignumber";

export interface IBuilderConstructor<T> {
  new (chainId: number): IBuilder<T>;
}

export interface IBuilder<T> {
  build(params: BaseBuildParams): T;
}

export interface BaseBuildParams {
  offerer: string;
  side: "buy" | "sell";
  tokenKind: "erc721" | "erc1155";
  contract: string;
  price: BigNumberish;
  endPrice?: BigNumberish;
  amount?: BigNumberish;
  paymentToken: string;
  fees?: {
    recipient: string;
    amount: BigNumberish;
    endAmount?: BigNumberish;
  }[];
  counter: BigNumberish;
  taker?: string;
  orderType?: number;
  zone?: string;
  zoneHash?: string;
  conduitKey?: string;
  salt?: BigNumberish;
  startTime?: number;
  endTime?: number;
  signature?: string;
}

export enum OrderType {
  FULL_OPEN,
  PARTIAL_OPEN,
  FULL_RESTRICTED,
  PARTIAL_RESTRICTED,
  CONTRACT,
}

export interface BaseOrderBuildOptions {
  maker: string;
  contract?: string;
  weiPrice: string;
  orderbook: "opensea" | "reservoir";
  orderType?: OrderType;
  currency?: string;
  quantity?: number;
  nonce?: string;
  fee?: number[];
  feeRecipient?: string[];
  listingTime?: number;
  expirationTime?: number;
  salt?: string;
  automatedRoyalties?: boolean;
  royaltyBps?: number;
  excludeFlaggedTokens?: boolean;
  source?: string;
}

export interface BaseOrderInfo {
  tokenKind: "erc721" | "erc1155";
  side: "sell" | "buy";
  contract: string;
  tokenId?: string;
  merkleRoot?: string;
  taker: string;
  amount: string;
  paymentToken: string;
  price: string;
  endPrice?: string;
  fees: {
    recipient: string;
    amount: BigNumberish;
    endAmount?: BigNumberish;
  }[];
  // For supporting dutch auctions
  isDynamic?: boolean;
}
