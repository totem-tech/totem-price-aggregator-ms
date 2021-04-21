import DataStorage from './utils/DataStorage'
import CouchDBStorage, { getConnection } from './utils/CouchDBStorage'
import { isArr, isStr } from './utils/utils'
import { getAbi } from './etherscanHelper'
import { getPrice } from './ethHelper'

const CouchDB_URL = process.env.CouchDB_URL
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
    const currenciesArr = await currenciesDB.getAll(null, true, limit)
    const currenciesMap = new Map(
        Array.from(currenciesArr)
            .map(([_, value]) => [value.ISO, value])
    )
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

    for (const [ISO, { ABI, contractAddress}] of Array.from(ABIs)) {
        const { priceUSD, updatedAt } = await getPrice(ABI, contractAddress)
        const currency = currenciesMap.get(ISO)
        if (!currency) {
            // ignore if currency not available in the currencies list
            currencies404.set(ISO, ISO)
            continue
        }

        // ignore if price hasn't changed since last update
        if (currency.priceUpdatedAt === updatedAt) {
            log(`${ISO} price unchanged since last update`)
            continue
        }
        
        // calcualte ratio of exchange using USD price
        const ROE = parseInt(priceUSD * 100000000)
        currency.ratioOfExchange = `${ROE}`
        currency.priceUpdatedAt = updatedAt
        log(ISO, priceUSD, ROE, updatedAt)
        await currenciesDB.set(currency._id, currency, true)
    }   
}

const start = () => exec()
    .catch(err => log(`Execution ended with error \n${err.stack}`))
    .finally(() => {
        log('Execution complete')
        if (!cycleDurationMin) return

        const delay = cycleDurationMin * 60 * 1000
        log(`waiting for ${cycleDurationMin} minutes before next execution`)
        setTimeout(start, delay)
    })

start()
