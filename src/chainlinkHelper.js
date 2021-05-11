import DataStorage from './utils/DataStorage'
import { getPrice } from './ethHelper'
import usdToROE from './usdToROE'
import log from './log'

const currencies404 = new DataStorage('currencies404.json', true)
/**
 * @name    getUpdatedCurrency
 * @summary retrieves currency price using ChainLink smart contract from Ethereum
 * 
 * @param   {String} ticker    symbol of the currency 
 * @param   {Object} ABI    Ethereum-compatible smart contract ABI
 * @param   {String} contractAddress Ethereum-compatible smart contract address
 * @param   {String} chain  Blockchain network. Currently supported: 'ethereum'.
 *                          Default: 'ethereum'
 * 
 * @returns {Array}         [ticker, { ratioOfExchange, priceUpdatedAt }]
 */
export const getLatestPrice = async (ticker, ABI, contractAddress, chain = 'ethereum') => {
    let result
    try {
        switch (chain) {
            case 'ethereum':
                result = await getPrice(ABI, contractAddress, ticker)
                break
            default:
                throw new Error('Unsupported chain')
        }
    } catch (err) {
        // prevent failing even if one currency request failed
        log(`${ticker} chainlink price update failed. ${err}`)
        return
    }
    const { priceUSD, updatedAt } = result

    return [
        ticker,
        {
            ratioOfExchange: usdToROE(priceUSD),
            priceUpdatedAt: updatedAt,
        }
    ]
}

/**
 * @name    getChainLinkPrices
 * @summary retrieves multiple currency prices using ChainLink smart contract from Ethereum
 *
 * @param   {Object} ABIEntries   list of all ABI entries from database
 * @param   {Object} currencies   list of all currencies available in the database
 *
 * @returns {Map}
 */
export const getChainLinkPrices = async (ABIEntries = new Map(), currencies = new Map()) => {
    log('Retrieving prices using ChainLink smart contracts')
    const c404 = new Map()
    const promises = Array.from(ABIEntries)
        .map(ABIEntry => {
            const [ticker, { ABI, active = true, contractAddress, source: chain }] = ABIEntry

            if (!active) return Promise.resolve()
            if (!currencies.get(ticker)) {
                c404.set(ticker, false)
                // resolve to empty result
                return Promise.resolve()
            }
            return getLatestPrice(ticker, ABI, contractAddress, chain)
        })
    if (c404.size) log(`Chainlink: following currencies not found in database =>  ${Array.from(c404).map(([x]) => x)}. To deactivate a ChainLink currency change/add property "active=false" in the "currencies_abi" database.`)
    currencies404.setAll(c404, true)
    const results = await Promise.all(promises)
    return new Map(results.filter(Boolean))
}