// ESM wrapper around the CommonJS implementation.
import mod from './index.js';

export const createServer = mod.createServer;
export const createHandler = mod.createHandler;
export const createCache = mod.createCache;
export const renderCard = mod.renderCard;
export const animeToCard = mod.animeToCard;
export const mapAnime = mod.mapAnime;
export const anilist = mod.anilist;
export const RARITIES = mod.RARITIES;
export const SIZE = mod.SIZE;
export const CardApiError = mod.CardApiError;

export default mod;
