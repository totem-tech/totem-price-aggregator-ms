import log from './log'
import CouchDBStorage, { isCouchDBStorage } from './utils/CouchDBStorage'
import PromisE from './utils/PromisE'
import { isDate, isObj, objToUrlParams } from './utils/utils'

const API_BASE_URL = 'https://www.alphavantage.co/query?'
const API_KEY = process.env.AA_API_Key
const LIMIT_DAY = parseInt(process.env.AA_Limit_Per_Day) || 500
const LIMIT_MINUTE = parseInt(process.env.AA_Limit_Per_Minute) || 5
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

/**
 * @name    getDailyPrice
 * @summary retrieves historical daily adjusted closing price of a stock or ETF. Alpha Vantage API documentation: https://www.alphavantage.co/documentation/#dailyadj
 * 
 * @param   {String}    ticker      Stock/ETF symbol. Eg: 'IBM'. Only single currency supported.
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
export const getDailyPrice = async (ticker, outputsize = outputSize.compact, dataType = resultType.json) => {
    if (!ticker) throw new Error('Ticker required')

    const params = {
        apikey: API_KEY,
        dataType,
        function: 'TIME_SERIES_DAILY_ADJUSTED',
        outputsize,
        symbol: ticker,
    }
    const url = `${API_BASE_URL}${objToUrlParams(params)}`
    const result = await PromisE.fetch(url, { method: 'get' }, 60000)
    if (dataType === resultType.csv) return result

    const dataKey = 'Time Series (Daily)'
    const data = (result || {})[dataKey]
    if (!isObj(data)) throw new Error('Invalid data received')

    return data
}

/**
 * @name    updateHistoricalData
 *
 * @param   {CouchDBStorage}    dbHistory       database to store daily prices
 * @param   {CouchDBStorage}    dbCurrencies    database containing list of all currencies and stocks
 */
export const updateStockDailyPrices = async (dbHistory, dbCurrencies) => {
    if (!isCouchDBStorage(dbHistory, dbCurrencies)) throw new Error(
        'Invalid CouchDBStorage instance supplied: dbHistory'
    )
    const currencies = await dbCurrencies.getAll(null, true, 999999)
    const stockCurrencies = Array.from(currencies)
        .filter(([_, x]) => ['stock'].includes(x.type))
    // list of all tickers to retrieve
    const tickers = stockCurrencies.map(x => [x.ticker, x._id])
        .slice(0, 1) // ToDo: remove
    const sort = [{ date: 'desc' }]
    // retrieve last available entries for each ticker
    // let lastEntries = await PromisE.all(
    //     tickers.map(([ticker]) =>
    //         dbHistory.search(
    //             { ticker },
    //             1, // limit to 1 result
    //             0,
    //             false,
    //             { sort },
    //         )
    //     )
    // )
    // // make it easily searchable by ticker
    // lastEntries = new Map(lastEntries.map(x => [x.ticker, x]))
    // 
    const promiseArr = stockCurrencies.map(([_, { priceUpdateTs, ticker }]) => {
        const { date } = lastEntries.get(ticker) || {}
        const size = !isDate(date) || (new Date() - new Date(date)) > ms100Days
            ? outputSize.full
            : outputSize.compact
        return getDailyPrice(ticker, size, resultType.json)
    })
    const results = await PromisE.all(promiseArr)
    const formatted = results.map((result, i) => {
        if (!result) return
        const ticker = tickers[i]
        const dates = Object.keys(result)
        const formattedResult = dates.map(date => ({
            ticker
        }))
        const latestPrice = formattedResult[dates[0]]
    }).filter(Boolean)

    console.log(JSON.stringify(results, null, 4))
}