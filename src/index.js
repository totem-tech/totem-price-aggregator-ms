import request from 'request'
import CoinGecko from 'coingecko-api'
import { v1 as uuidv1 } from 'uuid'
import DataStorage from './utils/DataStorage'
import CouchDBStorage, { getConnection } from './utils/CouchDBStorage'
import { arrSort, isArr, isDefined, isStr } from './utils/utils'
import { getAbi } from './etherscanHelper'
import { getPrice } from './ethHelper'
import PromisE from './utils/PromisE'

const CMC_URL = process.env.CMC_URL || ''
const CMC_APIKey = process.env.CMC_APIKey
const CouchDB_URL = process.env.CouchDB_URL
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
const DISCORD_WEBHOOK_AVATAR_URL = process.env.DISCORD_WEBHOOK_AVATAR_URL
const DISCORD_WEBHOOK_USERNAME = process.env.DISCORD_WEBHOOK_USERNAME
const CoinGeckoClient = new CoinGecko()
// number of minutes to wait for next execution. If falsy, will only execute once
const cycleDurationMin = parseInt(process.env.cycleDurationMin || 0)
// list of currencies to update
const currenciesDB = new CouchDBStorage(null, 'currencies')
const ABIsDB = new CouchDBStorage(null, 'currencies_abi')
// contract list: https://docs.chain.link/docs/ethereum-addresses
const contracts = new DataStorage('currency-contract-address.json', true)
const currencies404 = new DataStorage('currencies404.json', true)
const limit = 99999 // max number of currencies
const log = (...args) => console.log(new Date(), ...args)
const usdToROE = usd => parseInt(usd * 100000000)

const exec = async () => {
    log('Execution started')
    log('Retrieving list of ABIs from database...')
    // initiate global database connection
    await getConnection(CouchDB_URL)
    const ABIs = await ABIsDB.getAll(null, true, limit)

    // retrieve and store missing ABIs
    for (const [ISO, value] of contracts.toArray()) {
        let { contractAddress, decimals = 8 } = value || {}
        log(`Processing ${ISO} ${contractAddress}...`)
        if (!ISO || !isStr(ISO)) continue // ignore if ISO not provided or empty string
    
        const { ABI, contractAddress: ca } = await ABIs.get(ISO) || {}
        if (!isArr(ABI) || contractAddress !== ca) {
            log(`Retrieving ABI...`)
            // Retrieve ABI using Etherscan API
            const abiResult = await getAbi(contractAddress)
            ABI = JSON.parse(abiResult.result)
            if (!isArr(ABI)) throw new Error('Invalid ABI received!')

            log(`Saving ABI to database...`)
            ABIsDB.set(ISO, { ...value, decimals, ABI })
            // for local use
            ABIs.set(ISO, { ...value, decimals, ABI })
            contracts.delete(ISO)
        }
    }

    log('Retrieving list of currencies from database...')
    const currenciesArr = Array.from(await currenciesDB.getAll(null, true, limit))
    // make currencies easily searchable
    const currenciesMap = new Map(
        currenciesArr.map(([_, value]) => [value.ISO, value])
    )
    
    // Retrieve latest prices
    const cmcPrices = (await getCMCPrices()) || new Map()

    const cgPrices = (await getCoinGeckoPrices()) || new Map()
    log('Retrieving prices using ChainLink smart contracts')
    const c404 = new Map()
    const chainlinkPrices = new Map(await Promise.all(
        Array.from(ABIs)
            .map(ABIEntry => {
                const [ ISO ] = ABIEntry
                if (!currenciesMap.get(ISO)) {
                    c404.set(ISO, false)
                    log(`${ISO} Chainlink entry not in database`)
                }
                return getUpdatedCurrency(ABIEntry, currenciesMap)
            })
    ))
    
    // combine data from chainlink, cmc and existing database
    let updateCount = 0
    const updatedCurrencies = currenciesArr.map(([id, currency]) => {
        const { ISO, ratioOfExchange, priceUpdatedAt } = currency
        const clEntry = chainlinkPrices.get(ISO)
        const cgEntry = cgPrices.get(ISO)
        const cmcEntry = cmcPrices.get(ISO)
    
        const { ratioOfExchange: roe } = (clEntry || cgEntry || cmcEntry) || { ratioOfExchange }
        const { priceUpdatedAt: ts } = (clEntry || cgEntry || cmcEntry) || { priceUpdatedAt }

        const x = [
            id,
            {
                ...currency,
                marketCapUSD: (cgEntry || {}).marketCapUSD,
                rank: (cgEntry || {}).rank,
                ratioOfExchange: `${roe}`,
                source: clEntry
                    ? 'chain.link'
                    : cgEntry
                        ? 'coingecko.com'
                        : cmcEntry
                            ? 'coinmarketcap.com'
                            : 'totem.live',
                priceUpdatedAt: ts,
            }
        ]

        ratioOfExchange !== roe && updateCount++
        return x
    })
    log(`${updateCount} currency prices updated`)
    log('Updating database...')
    currenciesDB.setAll(new Map(updatedCurrencies), false)
}

const getCoinGeckoPrices = async () => {
    log('Retrieving list of coins using CoinGecko API')
    let { data: ids } = await CoinGeckoClient.coins.list()
    if (!isArr(ids)) {
        log('Invalid data received from CoinGecko')
        return
    }
    const symbols = new Map(ids.map(({id, symbol}) => [id, symbol]))
    ids = ids.map(({ id }) => id)
    const idGroups = new Array(Math.ceil(ids.length / 450))
        .fill(0)
        .map((_, i) => {
            const group = new Array(450)
                .fill(0)
                .map((_, n) => ids[i*450 + n])
            return group
        })
        .filter(Boolean)
    try {
        let results = await PromisE.all(
            idGroups.map(ids =>
                CoinGeckoClient.simple.price({
                    ids,
                    vs_currencies: 'usd',
                    include_last_updated_at: true,
                    include_market_cap: true,
                })
            )
        )
        results = results
            .map(x =>
                Object.keys(x.data)
                .map(id => [id, x.data[id]])
            )
            .flat()
            .filter(([id, {usd}]) => isDefined(usd) && isDefined(id))
            .map(([id, value]) => {
                const { usd, last_updated_at: ts, usd_market_cap: mc } = value
                return {
                    id,
                    marketCapUSD: mc || 0,
                    ratioOfExchange: usdToROE(usd),
                    priceUpdatedAt: !ts
                        ? undefined
                        : new Date(ts * 1000).toISOString(),
                }
            })
        // include rank by market cap
        results = arrSort(results, 'marketCapUSD', true)
            .map((entry, i) => [
                symbols.get(entry.id).toUpperCase(),
                { ...entry, rank: i + 1 },
            ])
        return new Map(results)
    } catch (err) {
        log(`Failed to retrieve price from CoinGecko. ${err}`, err)
        return
    }
    // const result = await CoinGeckoClient.simple.price({ ids: ids.slice(0, 450) })
    // log({result})
}

/**
 * @name    getCMCPrices
 * @summary retrieve list of all currencies using CMC Pro developer API
 * 
 * @returns {Map}
 */
const getCMCPrices = async () => {
    if (!CMC_URL || !CMC_APIKey) return

    log('Retrieving currencies from CMC', CMC_URL)
    const urlSuffix = 'cryptocurrency/listings/latest?start=1&limit=5000&convert=USD'
    const cmcurl = `${CMC_URL}${CMC_URL.endsWith('/') ? '' : '/'}${urlSuffix}`
    const options = { headers: { 'X-CMC_PRO_API_KEY': CMC_APIKey } }
    let result = (await PromisE.fetch(cmcurl, options)) || {}
    let { data } = result

    if (!isArr(data) || !data.length) {
        log('Invalid data received from CMC')
        return
    }

    data = data.map(entry => {
        const { 
            cmc_rank: rank,
            last_updated: priceUpdatedAt,
            quote: {
                USD: { price }
            },
            symbol: ISO,
        } = entry
        return [
            ISO,
            {
                rank,
                ratioOfExchange: usdToROE(price),
                priceUpdatedAt,
            }
        ]
    })
    return new Map(data)
}

/**
 * @name    getUpdatedCurrency
 * @summary retrieves currency price using ChainLink smart contract from Ethereum
 * 
 * @param   {Object} ABIEntry 
 * @param   {Object} currenciesMap 
 * 
 * @returns {Array}  Undefined if price is unchanged or unsupported.
 */
const getUpdatedCurrency = async(ABIEntry) => {
    const [ISO, { ABI, contractAddress }] = ABIEntry
    let result
    try {
        result = await getPrice(ABI, contractAddress)
    } catch (err) {
        // prevent failing even if one currency request failed
        log(`${ISO} chainlink price update failed. ${err}`)
        return
    }
    const { priceUSD, updatedAt } = result

    return [
        ISO,
        {
            ratioOfExchange: usdToROE(priceUSD),
            priceUpdatedAt: updatedAt,
        }
    ]
}

const start = () => exec()
    .catch(err => {
        const incidentID = uuidv1()
        log(`IncidentID: ${incidentID}: execution ended with error \n${err.stack}`)

        if (!DISCORD_WEBHOOK_URL) return

        // send message to discord
        const handleReqErr = err => err && console.log('Discord Webhook: failed to send error message. ', err)
        const content = '>>> ' + [
            `**IncidentID:** ${incidentID}`,
            '**Error:** ' + `${err}`.replace('Error:', ''),
        ].join('\n')
        request({
            json: true,
            method: 'POST',
            timeout: 30000,
            url: DISCORD_WEBHOOK_URL,
            body: {
                avatar_url: DISCORD_WEBHOOK_AVATAR_URL,
                content,
                username: DISCORD_WEBHOOK_USERNAME || 'Totem Price Aggregator Logger'
            }
        }, handleReqErr)
    })
    .finally(() => {
        log('Execution complete')
        if (!cycleDurationMin) return

        const delay = cycleDurationMin * 60 * 1000
        log(`Waiting ${cycleDurationMin} minutes before next execution`)
        setTimeout(start, delay)
    })
// start execution
start()
