import { csvToArr } from './utils/convert'
import CouchDBStorage, { isCouchDBStorage } from './utils/CouchDBStorage'
import DataStorage from './utils/DataStorage'
import PromisE from './utils/PromisE'
import { isArr, isDate, isObj, mapSort, objToUrlParams } from './utils/utils'
import { logIncident, logWithTag } from './log'
import { getHistoryItemId, usdToROE } from './utils'

const API_BASE_URL = 'https://www.alphavantage.co/query?'
const API_KEY = process.env.AA_API_Key
const LIMIT_DAY = parseInt(process.env.AA_Limit_Per_Day) || 500
const LIMIT_MINUTE = parseInt(process.env.AA_Limit_Per_Minute) || 5
const moduleName = 'AlphaVantage'
const debugTag = `[${moduleName}]`
export const sourceText = 'alphavantage.co'
// 100 days in milliseconds
const ms100Days = 1000 * 60 * 60 * 24 * 100
// result types
const resultType = {
    json: 'json',
    csv: 'csv',
}
// query output size
const outputSize = {
    compact: 'compact', // last 100 days
    full: 'full', // all available data
}
const log = logWithTag(debugTag)

/**
 * @name    fetchSupportedCryptoList
 * @summary fetch list of all supported cyrptocurrencies
 * 
 * @param   {Boolean} force if false, will only retrieve data if cached data is not available.
 * @returns 
 */
export const fetchSupportedCryptoList = async (force = false) => {
    const cryptoList = new DataStorage('alphavantage-crypto-list.json')
    let data = force
        ? new Map()
        : cryptoList.getAll()
    if (data.size) return data

    const result = await PromisE.fetch(
        'https://www.alphavantage.co/digital_currency_list/',
        { method: 'get' },
        5000,
        false,
    )
    const csvStr = await result.text()
    data = new Map(
        csvToArr(csvStr)
            .map(x => [
                x['currency code'],
                { name: x['currency name'] }
            ])
    )

    cryptoList.setAll(data, true)
    return data
}

/**
 * @name    getDailyPrice
 * @summary retrieves historical daily adjusted closing price of a stock or ETF. Alpha Vantage API documentation: https://www.alphavantage.co/documentation/#dailyadj
 * 
 * @param   {String}    symbol      Stock/ETF symbol. Eg: 'IBM'. Only single currency supported.
 * @param   {String}    outputsize  determines the number of days historical data to retrieve.
 *                                  Accepted values:
 *                                  - `compact`: 100 days data
 *                                  - `full`: all available data. Can be up to 20+ years.
 * @param   {String}    dataType    Accepted value:
 *                                  - 'json': returns object
 *                                  - 'csv': returns string with comma separated values
 * 
 * @returns {Object|String}
 * 
 * @example ```javascript
 * // Retrieve full daily price history of Tesla stock
 * const result =  getDailyPrice('TSLA', 'full', 'json')
 * // sample data:
 * {
 * "1999-11-18": {
 *         "1. open": "45.5",
 *         "2. high": "50.0",
 *         "3. low": "40.0",
 *         "4. close": "44.0",
 *         "5. adjusted close": "29.1067214009",
 *         "6. volume": "44739900",
 *         "7. dividend amount": "0.0000",
 *         "8. split coefficient": "1.0"
 *     }
 * }
 * ```
 */
export const getDailyPrice = async (symbol, outputsize = outputSize.compact, dataType = resultType.json) => {
    if (!symbol) throw new Error('Ticker required')

    const dataKey = 'Time Series (Daily)'
    const params = {
        apikey: API_KEY,
        symbol,
        function: 'TIME_SERIES_DAILY_ADJUSTED',
        dataType,
        outputsize,
    }
    const url = `${API_BASE_URL}${objToUrlParams(params)}`
    const result = await PromisE.fetch(url, { method: 'get' }, 60000)
    if (dataType === resultType.csv) return result

    const data = result[dataKey]
    const { Note, Information } = result
    if (!isObj(data)) {
        log(`$${symbol} request failed or invalid data received. Error message: ${Note || Information}`)
    }

    return data
}

/**
 * @name    updateHistoricalData
 *
 * @param   {CouchDBStorage}    dbHistory       database to store daily prices
 * @param   {CouchDBStorage}    dbCurrencies    database containing list of all currencies and stocks
 * @param   {Boolean}           updateDaily     Default: `true`
 */
export const updateStockDailyPrices = async (dbHistory, dbCurrencies, updateDaily = true) => {
    const debugTag = `[${moduleName}] [Daily]`
    try {
        log(
            debugTag,
            'Started retrieving daily stock prices.',
            `Limit per minute: ${LIMIT_MINUTE}.`,
            `Limit per day: ${LIMIT_DAY || 'infinite'}.`,
        )
        if (!isCouchDBStorage(dbHistory, dbCurrencies)) throw new Error(
            'Invalid CouchDBStorage instance supplied: dbHistory'
        )
        const priceKey = '5. adjusted close'
        const stockCurrencies = await dbCurrencies.search(
            { type: 'stock' },
            9999,
            0,
            false,
            { sort: ['ticker'] }, // sort by ticker
        )

        const queryData = stockCurrencies
            .map(({ priceUpdatedAt, ticker }, index) => {
                const date = priceUpdatedAt && `${priceUpdatedAt || ''}`.substr(0, 10)
                const yesterday = new Date(new Date() - 1000 * 60 * 60 * 24)
                    .toISOString()
                    .substr(0, 10)
                if (date && date >= yesterday) return

                const size = !isDate(new Date(date)) || (new Date() - new Date(date)) > ms100Days
                    ? outputSize.full
                    : outputSize.compact
                return [index, ticker, size, resultType.json]
            })
            .filter(Boolean)
            .slice(0, LIMIT_DAY || LIMIT_MINUTE * 59 * 24)

        const processNextBatch = async (batchData) => {
            const results = await PromisE.all(
                batchData.filter(Boolean).map(data =>
                    getDailyPrice(...data.slice(1))
                )
            )
            const currenciesUpdated = new Map()
            const dailyPriceEntries = results.map((result, i) => {
                if (!result) return
                const [currencyIndex] = batchData[i]
                const currency = stockCurrencies[currencyIndex]
                const { _id, priceUpdatedAt, ticker, type } = currency
                const lastDate = `${priceUpdatedAt || ''}`.substr(0, 10)
                const dates = Object.keys(result)
                    .filter(date => !lastDate || date > lastDate)

                // no update required
                if (!dates.length) return console.log(ticker, 'ignored')

                const entries = dates.map(date => ([
                    getHistoryItemId(date, ticker, type),
                    {
                        currencyId: _id,
                        date,
                        ratioOfExchange: usdToROE(parseFloat(result[date][priceKey]) || 0)
                    },
                ]))

                const { date, ratioOfExchange } = entries[0][1]
                currenciesUpdated.set(_id, {
                    ...currency,
                    ratioOfExchange,
                    priceUpdatedAt: `${date}T00:00:00Z`,
                    source: sourceText,
                })

                return entries
            })
                .flat()
                .filter(Boolean)

            log(currenciesUpdated.size, 'currencies updated')
            //update latest price of the currency entry
            currenciesUpdated.size && dbCurrencies.setAll(currenciesUpdated, false)

            // save daily prices
            log(dailyPriceEntries.length, 'daily stock price entries saved')
            await dbHistory.setAll(new Map(dailyPriceEntries), true)
            return dailyPriceEntries.length
        }

        const numBatches = parseInt(queryData.length / LIMIT_MINUTE)
        let totalSaved = 0
        log(`Updating ${queryData.length} stocks`)
        for (let i = 0; i < numBatches; i++) {
            const startIndex = i * LIMIT_MINUTE
            const endIndex = startIndex + LIMIT_MINUTE
            const batchData = queryData.slice(startIndex, endIndex)
            const batchTickers = batchData.map(ar => ' $' + ar[1])

            log(debugTag, `Retrieving stock prices ${startIndex + 1} to ${endIndex}:${batchTickers}`)
            try {
                const numSaved = await processNextBatch(batchData)
                totalSaved += numSaved || 0
            } catch (err) {
                if (`${err}`.includes('Thank you for using Alpha Vantage! Our standard API call frequency is')) {
                    logIncident(debugTag, 'Ran out of per-minute or daily credits!')
                } else {
                    logIncident(debugTag, 'Failed to retrieve daily stock prices of batch: ', batchTickers)
                }
            }

            if (i === numBatches - 1) continue

            log(debugTag, 'Waiting 1 minute to retrieve next batch...')
            // wait 1 minute and retrieve next batch next batch
            await PromisE.delay(1000 * 60)
        }

        log(debugTag, 'Finished retrieving daily stock prices. Total saved', totalSaved, 'entries')
    } catch (err) {
        log(debugTag, 'Failed to update daily stock prices')
    }
    if (!updateDaily) return
    log(debugTag, 'Waiting 24 hours for next execution...')
    setTimeout(() => {
        updateStockDailyPrices(dbHistory, dbCurrencies)
    }, 1000 * 60 * 60 * 24)
}
