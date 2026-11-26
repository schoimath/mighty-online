import {decideTableTurn, DEFAULT_MODEL} from './lab/table-agents.js?v=1.1.20261127031810';

self.onmessage = ({data}) => {
  self.postMessage({revision:data.revision, modelId:data.modelId ?? DEFAULT_MODEL, ...decideTableTurn(data)});
};
