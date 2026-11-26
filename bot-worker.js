import {decideTableTurn, DEFAULT_MODEL} from './lab/table-agents.js?v=1.1.20261126130555';

self.onmessage = ({data}) => {
  self.postMessage({revision:data.revision, modelId:data.modelId ?? DEFAULT_MODEL, ...decideTableTurn(data)});
};
