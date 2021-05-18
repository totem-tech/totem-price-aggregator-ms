import { generateHash } from "./utils/utils";

export const getHistoryItemId = (date, ticker, tickerType) => generateHash(`${date}_${ticker}.${tickerType}`)

/**
 * @name    usdToROE
 * @summary convert USD value to Ratio of Exchange
 * 
 * @param   {Number} usd USD value
 * 
 * @returns {Number}
 */
export const usdToROE = usd => parseInt(usd * 100000000)