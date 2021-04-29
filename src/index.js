import request from 'request'
import { Headers } from 'node-fetch'
import { v1 as uuidv1 } from 'uuid'
import DataStorage from './utils/DataStorage'
import CouchDBStorage, { getConnection } from './utils/CouchDBStorage'
import { isArr, isStr } from './utils/utils'
import { getAbi } from './etherscanHelper'
import { getPrice } from './ethHelper'
import PromisE from './utils/PromisE'

const CMC_URL = process.env.CMC_URL || ''
const CMC_APIKey = process.env.CMC_APIKey
const CouchDB_URL = process.env.CouchDB_URL
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
const DISCORD_WEBHOOK_AVATAR_URL = process.env.DISCORD_WEBHOOK_AVATAR_URL
const DISCORD_WEBHOOK_USERNAME = process.env.DISCORD_WEBHOOK_USERNAME
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
    let cmcPrices = await getCMCPrices()
    log('Retrieving prices using ChainLink smart contracts')
    const c404 = new Map()
    const chainlinkPrices = new Map(await Promise.all(
        Array.from(ABIs)
            .map(ABIEntry => {
                const [ ISO ] = ABIEntry
                if (!currenciesMap.get(ISO)) c404.set(ISO, false)
                return getUpdatedCurrency(ABIEntry, currenciesMap)
            })
    ))
    currencies404.setAll(c404, true)
    
    // combine data from chainlink, cmc and existing database
    let updateCount = 0
    const updatedCurrencies = currenciesArr.map(([id, currency]) => {
        const { ISO, ratioOfExchange, priceUpdatedAt } = currency
        const clEntry = chainlinkPrices.get(ISO)
        const cmcEntry = cmcPrices.get(ISO)
    
        const { ratioOfExchange: roe } = (clEntry || cmcEntry) || { ratioOfExchange }
        const { priceUpdatedAt: ts } = (clEntry || cmcEntry) || { priceUpdatedAt }
        const x = [
            id,
            {
                ...currency,
                rank: (cmcEntry || {}).rank,
                ratioOfExchange: `${roe}`,
                source: clEntry
                    ? 'chain.link'
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
