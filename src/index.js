import request from 'request'
import uuid from 'uuid'
import DataStorage from './utils/DataStorage'
import CouchDBStorage, { getConnection } from './utils/CouchDBStorage'
import { isArr, isStr } from './utils/utils'
import { getAbi } from './etherscanHelper'
import { getPrice } from './ethHelper'

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
const contracts = new DataStorage('currency-contract-address.json')
const currencies404 = new DataStorage('currencies404.json')
const limit = 99999 // max number of currencies
const log = (...args) => console.log(new Date(), ...args)

const exec = async () => {
    log('Execution started')
    log('Retrieving list of currencies...')
    // initiate global database connection
    await getConnection(CouchDB_URL)
    const ABIs = await ABIsDB.getAll(null, true, limit)

    // retrieve and store ABIs
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


    const currenciesArr = await currenciesDB.getAll(null, true, limit)
    // make currencies easily searchable
    const currenciesMap = new Map(
        Array.from(currenciesArr)
            .map(([_, value]) => [value.ISO, value])
    )

    // update prices
    let results = await Promise.all(
        Array.from(ABIs)
            .map(ABIEntry =>
                getUpdatedCurrency(ABIEntry, currenciesMap)
            )
    )
    results = new Map(results.filter(Boolean))
    if (results.size === 0) return log('No changes to database')
    
    log('Updating database...')
    currenciesDB.setAll(results, false)
}

/**
 * @name    getUpdatedCurrency
 * 
 * @param   {Object} ABIEntry 
 * @param   {Object} currenciesMap 
 * 
 * @returns {Array}
 */
const getUpdatedCurrency = async(ABIEntry, currenciesMap) => {
    const [ISO, { ABI, contractAddress }] = ABIEntry
    const { priceUSD, updatedAt } = await getPrice(ABI, contractAddress)
    const currency = currenciesMap.get(ISO)

    if (!currency) {
        // ignore if currency not available in the currencies list
        currencies404.set(ISO, ISO)
        log(`${ISO}: unsupported currency`)
        return
    }

    // ignore if price hasn't changed since last update
    if (currency.priceUpdatedAt === updatedAt) {
        log(`${ISO}: price unchanged since last update`)
        return
    }
    
    // calcualte ratio of exchange using USD price
    const ROE = parseInt(priceUSD * 100000000)
    currency.ratioOfExchange = `${ROE}`
    currency.priceUpdatedAt = updatedAt
    log(ISO, priceUSD, ROE, updatedAt)
    // await currenciesDB.set(currency._id, currency, true)
    return [currency._id, currency]
}

const start = () => exec()
    .catch(err => {
        const incidentID = uuid.v1()
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
