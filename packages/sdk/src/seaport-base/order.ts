import { Provider } from "@ethersproject/abstract-provider";
import { BaseOrderInfo } from "./builders/base";
import { IExchange, ISignatureData, OrderComponents } from "./types";

export interface IOrder {
  chainId: number;
  params: OrderComponents;

  hash(): string;

  getInfo(): BaseOrderInfo | undefined;

  getSignatureData(): ISignatureData;

  checkSignature(provider?: Provider): Promise<void>;

  offChainCheck(options?: {
    onChainApprovalRecheck?: boolean;
    checkFilledOrCancelled?: boolean;
    singleTokenERC721ApprovalCheck?: boolean;
  }): Promise<void>;

  getExchange(): IExchange;

  supportBulk(): boolean;
}
