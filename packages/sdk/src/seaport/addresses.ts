import { ChainIdToAddress, Network } from "../utils";

export const Exchange: ChainIdToAddress = {
  [Network.Ethereum]: "0x00000000006c3852cbef3e08e8df289169ede581",
  [Network.EthereumGoerli]: "0x00000000006c3852cbef3e08e8df289169ede581",
  [Network.Optimism]: "0x00000000006c3852cbef3e08e8df289169ede581",
  [Network.Gnosis]: "0x00000000006c3852cbef3e08e8df289169ede581",
  [Network.Polygon]: "0x00000000006c3852cbef3e08e8df289169ede581",
  [Network.PolygonMumbai]: "0x00000000006c3852cbef3e08e8df289169ede581",
  [Network.Arbitrum]: "0x00000000006c3852cbef3e08e8df289169ede581",
  [Network.AvalancheFuji]: "0x00000000006c3852cbef3e08e8df289169ede581",
  [Network.Avalanche]: "0x00000000006c3852cbef3e08e8df289169ede581",
};

export const ConduitController: ChainIdToAddress = {
  [Network.Ethereum]: "0x00000000f9490004c11cef243f5400493c00ad63",
  [Network.EthereumGoerli]: "0x00000000f9490004c11cef243f5400493c00ad63",
  [Network.Optimism]: "0x00000000f9490004c11cef243f5400493c00ad63",
  [Network.Gnosis]: "0x00000000f9490004c11cef243f5400493c00ad63",
  [Network.Polygon]: "0x00000000f9490004c11cef243f5400493c00ad63",
  [Network.PolygonMumbai]: "0x00000000f9490004c11cef243f5400493c00ad63",
  [Network.Arbitrum]: "0x00000000f9490004c11cef243f5400493c00ad63",
  [Network.AvalancheFuji]: "0x00000000f9490004c11cef243f5400493c00ad63",
  [Network.Avalanche]: "0x00000000f9490004c11cef243f5400493c00ad63",
};

export const PausableZone: ChainIdToAddress = {
  [Network.Ethereum]: "0x004c00500000ad104d7dbd00e3ae0a5c00560c00",
  [Network.Polygon]: "0x004c00500000ad104d7dbd00e3ae0a5c00560c00",
};

export const ApprovalOrderZone: ChainIdToAddress = {
  [Network.Ethereum]: "0x7deb43ea42555922445abc2f8ec66d5fce8c92c0",
  [Network.EthereumGoerli]: "0x5595ddec926bfb297814c33a90e44f97c6074fe5",
};

export const OpenseaConduitKey: ChainIdToAddress = {
  [Network.Ethereum]: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
  [Network.EthereumGoerli]: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
  [Network.Polygon]: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
  [Network.Optimism]: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
};

export const OpenseaConduit: ChainIdToAddress = {
  [Network.Ethereum]: "0x1e0049783f008a0085193e00003d00cd54003c71",
  [Network.EthereumGoerli]: "0x1e0049783f008a0085193e00003d00cd54003c71",
  [Network.Polygon]: "0x1e0049783f008a0085193e00003d00cd54003c71",
  [Network.Optimism]: "0x1e0049783f008a0085193e00003d00cd54003c71",
};

// https://github.com/ProjectOpenSea/seaport/blob/0a8e82ce7262b5ce0e67fa98a2131fd4c47c84e9/contracts/conduit/ConduitController.sol#L493
export const ConduitCodeHash: ChainIdToAddress = {
  [Network.Ethereum]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
  [Network.EthereumGoerli]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
  [Network.Optimism]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
  [Network.Gnosis]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
  [Network.Polygon]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
  [Network.PolygonMumbai]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
  [Network.Arbitrum]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
  [Network.AvalancheFuji]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
  [Network.Avalanche]: "0x023d904f2503c37127200ca07b976c3a53cc562623f67023115bf311f5805059",
};
