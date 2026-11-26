import {analyzeSetting} from './table-claim.js?v=1.1.20261126122838';

self.onmessage = ({data}) => {
  // Open tabs from the previous release submit the position directly.
  const verdict = analyzeSetting(data.position ?? data);
  self.postMessage(data.position ? verdict : verdict.success);
};
