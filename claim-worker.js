import {canSweepRemaining} from './table-claim.js';

self.onmessage = ({data}) => {
  self.postMessage(canSweepRemaining(data));
};
