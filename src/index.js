import CouchDBStorage, { getConnection } from './utils/CouchDBStorage'
import DataStorage from './utils/DataStorage'
import { arrSort, isArr, isDefined, isStr, sort } from './utils/utils'
import { getAbi } from './etherscanHelper'
import { getCMCPrices } from './cmcHelper'
import { getLatestPrices as getCoinGeckoPrices, updateCryptoDailyPrices } from './coinGeckoHelper'
import { getChainLinkPrices } from './chainlinkHelper'
import log, { logIncident } from './log'
import { updateStockDailyPrices } from './alphaVantageHelper'

const CouchDB_URL = process.env.CouchDB_URL
// number of minutes to wait for next execution. If falsy, will only execute once
const cycleDurationMin = parseInt(process.env.cycleDurationMin || 0)
// list of currencies to update
const dbCurrencies = new CouchDBStorage(null, 'currencies')
const dbABIs = new CouchDBStorage(null, 'currencies_abi')
const dbDailyHistory = new CouchDBStorage(null, 'currency_price_history_daily')
// contract list: https://docs.chain.link/docs/ethereum-addresses
const contracts = new DataStorage('currency-contract-address.json', true)
const limit = 99999 // max number of currencies

const updateLatestPrices = async () => {
    try {
        log('Execution started')
        log('Retrieving list of ABIs from database...')
        // initiate global database connection
        await getConnection(CouchDB_URL)
        const ABIs = await dbABIs.getAll(null, true, limit)

        // retrieve and store missing ABIs
        for (const [ticker, value] of contracts.toArray()) {
            let { contractAddress, decimals = 8 } = value || {}
            log(`Processing ${ticker} ${contractAddress}...`)
            if (!ticker || !isStr(ticker)) continue // ignore if ticker is not provided or empty string

            const { ABI, contractAddress: ca } = await ABIs.get(ticker) || {}
            if (!isArr(ABI) || contractAddress !== ca) {
                log(`Retrieving ABI...`)
                // Retrieve ABI using Etherscan API
                const abiResult = await getAbi(contractAddress)
                ABI = JSON.parse(abiResult.result)
                if (!isArr(ABI)) throw new Error('Invalid ABI received!')

                log(`Saving ABI to database...`)
                const entry = { active: true, ...value, decimals, ABI }
                dbABIs.set(ticker, entry)
                // for local use
                ABIs.set(ticker, entry)
                contracts.delete(ticker)
            }
        }

        log('Retrieving list of currencies from database...')
        const currenciesArr = Array.from(
            await dbCurrencies.getAll(null, true, limit)
        ).filter(([_, { type }]) =>
            ['cryptocurrency', 'fiat'].includes(type)
        )
        // make currencies easily searchable
        const currenciesMap = new Map(
            currenciesArr
                .filter(([_, { type }]) => ['cryptocurrency', 'fiat'].includes(type))
                .map(([_, value]) => [value.ticker, value])
        )

        // Retrieve latest prices
        // Coin Market Cap
        const cmcPrices = (await getCMCPrices()) || new Map()
        // Coin Gecko
        const cgPrices = (await getCoinGeckoPrices()) || new Map()
        // ChainLink smart contracts
        const chainlinkPrices = await getChainLinkPrices(ABIs, currenciesMap)

        // combine data from chainlink, cmc and existing database
        const updatedCurrencies = currenciesArr.map(([id, currency]) => {
            const { ratioOfExchange, priceUpdatedAt, ticker, type } = currency
            const clEntry = chainlinkPrices.get(ticker)
            const cgEntry = cgPrices.get(ticker)
            const cmcEntry = cmcPrices.get(ticker)
            const fiat = type === 'fiat'
            // Only use Chainlink for fiat prices
            const targetEntry = (clEntry || !fiat ? (cgEntry || cmcEntry) : {}) || {}
            let {
                ratioOfExchange: roe = ratioOfExchange,
                priceUpdatedAt: ts = priceUpdatedAt
            } = targetEntry || {}
            let source = clEntry
                ? 'chain.link'
                : !fiat && cgEntry
                    ? 'coingecko.com'
                    : !fiat && cmcEntry
                        ? 'coinmarketcap.com'
                        : 'totem.live'

            if (ticker === 'USD') {
                // make sure USD is never changed by mistake
                roe = 100000000
                ts = undefined
                source = undefined
            }
            // ignore if price hasn't changed
            if (`${roe}` === `${ratioOfExchange}`) return

            return [
                id,
                {
                    ...currency,
                    marketCapUSD: (cgEntry || {}).marketCapUSD,
                    rank: (cgEntry || {}).rank,
                    ratioOfExchange: roe,
                    source,
                    priceUpdatedAt: ts,
                }
            ]
        }).filter(Boolean)
        if (updatedCurrencies.length) {
            log('Updating database...',)
            await dbCurrencies.setAll(new Map(updatedCurrencies), false)
        }
        log(`${updatedCurrencies.length} currencies updated`)
    } catch (err) {
        const incidentID = logIncident(err, incidentID)
        log(`IncidentID: ${incidentID}: execution ended with error \n${err.stack}`)
    }

    log('Execution complete')
    if (!cycleDurationMin) return

    const delay = cycleDurationMin * 60 * 1000
    log(`Waiting ${cycleDurationMin} minutes before next execution`)
    setTimeout(updateLatestPrices, delay)
}

// initiate global database connection
getConnection(CouchDB_URL).then(() => {
    // updateLatestPrices()
    // 
    // updateStockDailyPrices(dbDailyHistory, dbCurrencies, true)
    updateCryptoDailyPrices(dbDailyHistory, dbCurrencies, true)
})