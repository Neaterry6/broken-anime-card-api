/** A normalised anime record from AniList. */
export interface Anime {
  id: number;
  title: string | null;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  synopsis: string | null;
  format: string | null;
  status: string | null;
  year: number | null;
  episodes: number | null;
  duration: number | null;
  score: number | null;
  popularity: number | null;
  favourites: number | null;
  genres: string[];
  isAdult: boolean;
  cover: string | null;
  banner: string | null;
  studios: string[];
}

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

/** Card fields, plus the API-only extras. */
export interface Card {
  name: string;
  title?: string | null;
  anime?: string | null;
  description?: string | null;
  image?: string | null;
  rarity?: Rarity;
  power?: number;
  speed?: number;
  intellect?: number;
  abilities?: string[];
  /** Present when the card came from animeToCard(). */
  animeId?: number;
  score?: number | null;
  popularity?: number | null;
  isAdult?: boolean;
  cover?: string | null;
  banner?: string | null;
  genres?: string[];
  status?: string | null;
  episodes?: number | null;
  year?: number | null;
}

export interface RaritySpec {
  label: string;
  colors: [string, string];
  glow: string;
  stars: number;
}

export interface RenderOptions {
  /** 240-2000. Height follows the 5:7 ratio. Default 500. */
  width?: number;
  /** Holographic overlay. Default true. */
  shine?: boolean;
}

export interface CacheOptions {
  /** Entry lifetime in ms. Default 300000 (5 minutes). */
  ttlMs?: number;
  /** Max entries before eviction. Default 500. */
  max?: number;
}

export interface Cache {
  get(key: string): unknown;
  set(key: string, value: unknown): unknown;
  clear(): void;
  readonly size: number;
}

export interface ServerOptions {
  /** 0 gives a random free port. Default 3000. */
  port?: number;
  host?: string;
  render?: RenderOptions;
}

export type CardApiErrorCode =
  | 'MISSING_QUERY'
  | 'BAD_ID'
  | 'MISSING_NAME'
  | 'BAD_INPUT'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UPSTREAM_ERROR'
  | 'BAD_RESPONSE'
  | 'INTERNAL';

export declare class CardApiError extends Error {
  name: 'CardApiError';
  code: CardApiErrorCode;
  /** HTTP status this maps to. */
  status: number;
  constructor(message: string, code: CardApiErrorCode, status?: number);
}

/** Render a card as a standalone SVG document. */
export declare function renderCard(card: Card, options?: RenderOptions): string;

/** Turn an anime record into deterministic card fields. */
export declare function animeToCard(anime: Anime): Card;

/** Map a raw AniList media object into a normalised Anime. */
export declare function mapAnime(media: unknown): Anime | null;

/** Run a GraphQL query against AniList with retries. */
export declare function anilist(
  query: string,
  variables?: Record<string, unknown>,
  options?: { timeoutMs?: number; retries?: number }
): Promise<any>;

export declare function createCache(options?: CacheOptions): Cache;

/** The request handler. Mount it in your own server if you prefer. */
export declare function createHandler(options?: ServerOptions): (
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse
) => Promise<void>;

/** Start the API. Resolves with the listening server. */
export declare function createServer(options?: ServerOptions): Promise<import('http').Server>;

export declare const RARITIES: Readonly<Record<Rarity, RaritySpec>>;
export declare const SIZE: Readonly<{ width: number; height: number }>;
export declare const USER_AGENT: string;

declare const _default: {
  createServer: typeof createServer;
  createHandler: typeof createHandler;
  createCache: typeof createCache;
  renderCard: typeof renderCard;
  animeToCard: typeof animeToCard;
  mapAnime: typeof mapAnime;
  anilist: typeof anilist;
  RARITIES: typeof RARITIES;
  SIZE: typeof SIZE;
  CardApiError: typeof CardApiError;
};
export default _default;
