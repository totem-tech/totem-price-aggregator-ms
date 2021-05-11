/**
 * @name    usdToROE
 * @summary convert USD value to Ratio of Exchange
 * 
 * @param   {Number} usd USD value
 * 
 * @returns {Number}
 */
export default usd => parseInt(usd * 100000000)