import { ChainIdToAddress, Network } from "../utils";

export const Exchange: ChainIdToAddress = {
  [Network.Ethereum]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.EthereumGoerli]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Optimism]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Gnosis]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Polygon]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.PolygonMumbai]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Arbitrum]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.AvalancheFuji]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Avalanche]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
};

export const ConduitController: ChainIdToAddress = {
  [Network.Ethereum]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.EthereumGoerli]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Optimism]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Gnosis]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Polygon]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.PolygonMumbai]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Arbitrum]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.AvalancheFuji]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
  [Network.Avalanche]: "0x9c390EFB05e09982E23993EBFA3b32c190e25f4B",
};

// Conduits

export const OpenseaConduitKey: ChainIdToAddress = {
  [Network.Ethereum]: "0x7e727520b29773e7f23a8665649197aaf064cef1000000000000000000000001",
  [Network.EthereumGoerli]: "0x7e727520b29773e7f23a8665649197aaf064cef1000000000000000000000001",
  [Network.Polygon]: "0x7e727520b29773e7f23a8665649197aaf064cef1000000000000000000000001",
  [Network.Optimism]: "0x7e727520b29773e7f23a8665649197aaf064cef1000000000000000000000001",
};

export const OpenseaConduit: ChainIdToAddress = {
  [Network.Ethereum]: "0x9377b61ba41d889fd7cd3f24d1627e42f93a5d0611646a9a76f055f7973c7434",
  [Network.EthereumGoerli]: "0x9377b61ba41d889fd7cd3f24d1627e42f93a5d0611646a9a76f055f7973c7434",
  [Network.Polygon]: "0x9377b61ba41d889fd7cd3f24d1627e42f93a5d0611646a9a76f055f7973c7434",
  [Network.Optimism]: "0x9377b61ba41d889fd7cd3f24d1627e42f93a5d0611646a9a76f055f7973c7434",
};

// Zones

export const PausableZone: ChainIdToAddress = {
  [Network.Ethereum]: "0x004c00500000ad104d7dbd00e3ae0a5c00560c00",
  [Network.Polygon]: "0x004c00500000ad104d7dbd00e3ae0a5c00560c00",
};

export const OpenSeaProtectedOffersZone: ChainIdToAddress = {
  [Network.Ethereum]: "0x000000e7ec00e7b300774b00001314b8610022b8",
  [Network.EthereumGoerli]: "0x000000e7ec00e7b300774b00001314b8610022b8",
  [Network.Polygon]: "0x000000e7ec00e7b300774b00001314b8610022b8",
  [Network.Optimism]: "0x000000e7ec00e7b300774b00001314b8610022b8",
};

export const CancellationZone: ChainIdToAddress = {
  [Network.Ethereum]: "0xaa0e012d35cf7d6ecb6c2bf861e71248501d3226",
  [Network.EthereumGoerli]: "0x49b91d1d7b9896d28d370b75b92c2c78c1ac984a",
};
