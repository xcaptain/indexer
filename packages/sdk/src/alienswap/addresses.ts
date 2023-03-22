import { ChainIdToAddress, Network } from "../utils";

export const Exchange: ChainIdToAddress = {
  [Network.Ethereum]: "0x7374fe94e34c209616cec0610212de13151d222f",
  [Network.EthereumGoerli]: "0x7374fe94e34c209616cec0610212de13151d222f",
  [Network.Optimism]: "0x7374fe94e34c209616cec0610212de13151d222f",
  [Network.Gnosis]: "0x7374fe94e34c209616cec0610212de13151d222f",
  [Network.Polygon]: "0x7374fe94e34c209616cec0610212de13151d222f",
  [Network.PolygonMumbai]: "0x7374fe94e34c209616cec0610212de13151d222f",
  [Network.Arbitrum]: "0x7374fe94e34c209616cec0610212de13151d222f",
  [Network.AvalancheFuji]: "0x7374fe94e34c209616cec0610212de13151d222f",
  [Network.Avalanche]: "0x7374fe94e34c209616cec0610212de13151d222f",
};

export const ConduitController: ChainIdToAddress = {
  [Network.Ethereum]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
  [Network.EthereumGoerli]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
  [Network.Optimism]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
  [Network.Gnosis]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
  [Network.Polygon]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
  [Network.PolygonMumbai]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
  [Network.Arbitrum]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
  [Network.AvalancheFuji]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
  [Network.Avalanche]: "0xc04dd964ed36c0e4796f53a7168393ed4fc38ff6",
};

// Conduits

export const OpenseaConduitKey: ChainIdToAddress = {
  [Network.Ethereum]: "0x7e727520b29773e7f23a8665649197aaf064cef1000000000000000000000001",
  [Network.EthereumGoerli]: "0x7e727520b29773e7f23a8665649197aaf064cef1000000000000000000000001",
  [Network.Polygon]: "0x7e727520b29773e7f23a8665649197aaf064cef1000000000000000000000001",
  [Network.Optimism]: "0x7e727520b29773e7f23a8665649197aaf064cef1000000000000000000000001",
};

export const OpenseaConduit: ChainIdToAddress = {
  [Network.Ethereum]: "0x6e2809e67faae9d3127f87e669b5f5deb46ff0a3",
  [Network.EthereumGoerli]: "0x6e2809e67faae9d3127f87e669b5f5deb46ff0a3",
  [Network.Polygon]: "0x6e2809e67faae9d3127f87e669b5f5deb46ff0a3",
  [Network.Optimism]: "0x6e2809e67faae9d3127f87e669b5f5deb46ff0a3",
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
