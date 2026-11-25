import {decideTableTurn, DEFAULT_MODEL} from './lab/table-agents.js';

self.onmessage = ({data}) => {
  self.postMessage({revision:data.revision, modelId:data.modelId ?? DEFAULT_MODEL, ...decideTableTurn(data)});
};
