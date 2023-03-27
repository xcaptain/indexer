export type OrderKind = "contract-wide" | "single-token" | "token-list";

export enum ItemType {
  NATIVE,
  ERC20,
  ERC721,
  ERC1155,
  ERC721_WITH_CRITERIA,
  ERC1155_WITH_CRITERIA,
}

export enum OrderType {
  FULL_OPEN,
  PARTIAL_OPEN,
  FULL_RESTRICTED,
  PARTIAL_RESTRICTED,
  CONTRACT,
}

export type OfferItem = {
  itemType: ItemType;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
};

export type ConsiderationItem = {
  itemType: ItemType;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
  recipient: string;
};

export type OrderComponents = {
  kind?: OrderKind;
  offerer: string;
  zone: string;
  offer: OfferItem[];
  consideration: ConsiderationItem[];
  orderType: OrderType;
  startTime: number;
  endTime: number;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
  signature?: string;
};

export type ORDER_EIP712_TYPES = {
  OrderComponents: { name: string; type: string }[];
  OfferItem: { name: string; type: string }[];
  ConsiderationItem: { name: string; type: string }[];
};

export type Eip712Domain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
};
export type ISignatureData = {
  signatureKind: string;
  domain: Eip712Domain;
  types: ORDER_EIP712_TYPES;
  value: OrderComponents;
};

export interface IExchange {
  deriveConduit(conduitKey: string): string;
}
