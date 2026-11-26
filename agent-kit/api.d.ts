export type Seat = 0 | 1 | 2 | 3 | 4;
export type Suit = 'S' | 'H' | 'D' | 'C';
export type Trump = Suit | 'N';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type Card = `${Suit}${Rank}` | 'JK';
export interface Contract { suit: Trump; points: number }
export type Call = {kind:'card'; card:Card} | {kind:'first' | 'none'};
export interface Play { card:Card; suit?:Suit; jokerCall?:boolean }
export type Played = Play & {seat:Seat};
export interface Trick { number:number; winner:Seat; points:number; cards:Played[] }
export type Action =
  | {type:'pass'}
  | ({type:'bid'} & Contract)
  | {type:'discard'; cards:[Card,Card,Card]; contract?:Contract}
  | ({type:'friend'} & Call)
  | ({type:'play'} & Play);
export interface Observation {
  phase:'bid'|'discard'|'friend'|'play'; seat:Seat; turn:Seat; dealNo:number;
  rules:{minBid:number; allowFirstFriend:boolean; allowFirstJokerCall:boolean; allowLastJoker:boolean};
  hand:Card[]; counts:number[]; passed:boolean[]; bid:({seat:Seat} & Contract)|null;
  bidHistory:({seat:Seat; pass:true}|({seat:Seat} & Contract))[];
  declarer:Seat|null; friendKnown:boolean; friend:Seat|null; call:Call|null;
  selfRole:'unknown'|'declarer'|'friend'|'opposition';
  trick:Played[]; trickNo:number; playedTricks:Trick[];
  lastTrick:(Omit<Trick,'points'> & {points:number|null; finalPlay?:Played})|null;
  jokerPlayed:boolean; scores:(number|null)[]; captured:Card[][];
  knownKitty:Card[]; discarded:Card[];
  choices:{canPass:boolean; bids:Contract[]; discard:boolean; contracts:Contract[]; friends:Call[]; plays:Play[]};
}
export interface TurnRequest { apiVersion:1; seed:number; observation:Observation }
export interface MightyAgent {
  apiVersion:1; id:string; label:string; description:string;
  decide(request:TurnRequest):Action;
}
