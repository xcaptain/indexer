import { IOrder, SeaportOrderKind } from "../seaport-base/order";
import { Order as SeaportV14Order } from "../seaport-v1.4/order";

export class Order extends SeaportV14Order implements IOrder {
  public getKind(): SeaportOrderKind {
    return SeaportOrderKind.ALIENSWAP;
  }
}
