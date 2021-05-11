import PromisE from './utils/PromisE'
import { isArr } from './utils/utils'
import usdToROE from './usdToROE'
import log from './log'

const CMC_URL = process.env.CMC_URL || ''
const CMC_APIKey = process.env.CMC_APIKey


/**
 * @name    getCMCPrices
 * @summary retrieve list of all currencies using CMC Pro developer API
 * 
 * @returns {Map}
 */
export const getCMCPrices = async () => {
    if (!CMC_URL || !CMC_APIKey) return

    log('Retrieving currencies from CMC', CMC_URL)
    const urlSuffix = 'cryptocurrency/listings/latest?start=1&limit=5000&convert=USD'
    const cmcurl = `${CMC_URL}${CMC_URL.endsWith('/') ? '' : '/'}${urlSuffix}`
    const options = { headers: { 'X-CMC_PRO_API_KEY': CMC_APIKey } }
    let data
    try {
        const result = await PromisE.fetch(cmcurl, options)
        data = (result || {}).data
    } catch (err) {
        log('Failed to retrieve prices from CMC', err)
    }

    if (!isArr(data) || !data.length) {
        log('Invalid data received from CMC')
        return
    }

    data = data.map(entry => {
        const {
            cmc_rank: rank,
            last_updated: priceUpdatedAt,
            quote: { USD: { price } },
            symbol: ticker,
        } = entry
        return [
            ticker,
            {
                rank,
                ratioOfExchange: usdToROE(price),
                priceUpdatedAt,
            }
        ]
    })
    return new Map(data)
}