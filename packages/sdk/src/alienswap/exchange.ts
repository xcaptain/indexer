import { Exchange as SeaportV14Exchange } from "../seaport-v1.4/exchange";
import { Contract } from "@ethersproject/contracts";
import * as Addresses from "./addresses";
import ExchangeAbi from "./abis/Exchange.json";
import { AddressZero } from "@ethersproject/constants";
import { IOrder } from "../seaport-base/order";

export class Exchange extends SeaportV14Exchange {
  protected exchangeAddress: string;
  protected cancellationZoneAddress: string = AddressZero;
  public contract: Contract;

  constructor(chainId: number) {
    super(chainId);
    this.exchangeAddress = Addresses.Exchange[chainId];
    this.contract = new Contract(this.exchangeAddress, ExchangeAbi);
  }

  // --- Get extra data ---
  // not support off chain cancellation at present
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public requiresExtraData(_order_: IOrder): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public async getExtraData(_order: IOrder): Promise<string> {
    return "0x";
  }
}
