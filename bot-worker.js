import {botDecision} from './engine.js';

self.onmessage = ({data: {revision, view}}) => {
  self.postMessage({revision, action: botDecision(view)});
};
