import { csvToArr } from './utils/convert'
import CouchDBStorage, { isCouchDBStorage } from './utils/CouchDBStorage'
import DataStorage from './utils/DataStorage'
import PromisE from './utils/PromisE'
import { isObj, isValidDate, objToUrlParams } from './utils/utils'
import { log, logIncident, logWithTag } from './log'
import { getHistoryItemId, usdToROE } from './utils'

const API_BASE_URL = 'https://www.alphavantage.co/query?'
// const getApiKey() = process.env.AA_API_Key
const apiKeys = `${process.env.AA_API_Key || ''}`
    .trim()
    .split(',')
    .filter(Boolean)
const LIMIT_DAY = parseInt(process.env.AA_Limit_Per_Day) || 500
const LIMIT_MINUTE = parseInt(process.env.AA_Limit_Per_Minute) || 5
const moduleName = 'AlphaVantage'
const debugTag = `[${moduleName}]`
export const sourceText = 'alphavantage.co'
// 100 days in milliseconds
const ms1Day = 1000 * 60 * 60 * 24
const ms100Days = 1000 * 60 * 60 * 24 * 100
const currencyTypes = {
    fiat: 'fiat',
    stock: 'stock',
}
// result types
const dataTypes = {
    json: 'json',
    csv: 'csv',
}
// query output size
const outputSizes = {
    compact: 'compact', // last 100 days
    full: 'full', // all available data
}

/**
 * 
 * @param   {Object} result 
 * @param   {String} dataKey 
 * 
 * @returns {Array} [data, apiErrorMsg, warningMsg]
 */
const checkAPIError = (result = {}, dataKey) => {
    if (!isObj(result)) return []

    const data = result[dataKey]
    let err = result['Error Message']
    let warningMsg = ''
    if (err) return [data, err, warningMsg]

    // request successful
    if (isObj(data)) return [data]

    const { Note, Information } = result
    const msg = Note || Information || ''
    const limitExceeded = `${msg}`.includes('Thank you for using Alpha Vantage!')
    if (limitExceeded) {
        warningMsg = 'Exceeded per-minute or daily requests!'
    } else {
        err = `$${symbol} request failed or invalid data received. Error message: ${msg}`
    }

    return [data, err, warningMsg]
}

/**
 * @name    fetchSupportedList
 * @summary fetch list of all supported cyrptocurrencies
 * 
 * @param   {String}    currencyType    see `currencyTypes` for list of supported types
 * @param   {Boolean}   force           if false, will only retrieve data if cached data is not available.
 * @returns 
 */
export const fetchSupportedList = async (currencyType, force = false) => {
    if (!currencyTypes[currencyType]) throw new Error('Invalid currency type')

    const list = new DataStorage(`alphavantage-${currencyType}-list.json`)
    let data = force
        ? new Map()
        : list.getAll()
    if (data.size) return data

    const typeName = currencyType === currencyTypes.fiat
        ? 'physical'
        : 'digital'
    const result = await PromisE.fetch(
        `https://www.alphavantage.co/${typeName}_currency_list/`,
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

    list.setAll(data, true)
    return data
}

const getApiKey = () => {
    const { index = -1 } = getApiKey
    getApiKey.index = apiKeys.length - 1 === index
        ? 0
        : index + 1
    return apiKeys[getApiKey.index]
}

/**
 * @name    getDailyStockPrice
 * @summary retrieves historical daily adjusted closing price of a stock or ETF. Alpha Vantage API documentation: https://www.alphavantage.co/documentation/#dailyadj
 * 
 * @param   {String}    symbol      Stock/ETF symbol. Eg: 'IBM'. Only single currency supported.
 * @param   {String}    outputSize  determines the number of days historical data to retrieve.
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
 * const result =  getDailyStockPrice('TSLA', 'full', 'json')
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
export const getDailyStockPrice = async (symbol, outputSize, dataType = dataTypes.json) => {
    if (!symbol) throw new Error('Symbol required')
    if (!apiKeys.length) throw new Error('AlphaAdvantage API required')

    const dataKey = 'Time Series (Daily)'
    const params = {
        apikey: getApiKey(),
        symbol,
        function: 'TIME_SERIES_DAILY_ADJUSTED',
        datatype: dataType,
        outputsize: outputSize,
    }
    const url = `${API_BASE_URL}${objToUrlParams(params)}`
    const result = await PromisE.fetch(url, { method: 'get' }, 30000)
    if (dataType === dataTypes.csv) return result

    const _debugTag = `${debugTag} [Daily] [Stock]`
    const [data, err, warning] = checkAPIError(result, dataKey) || []
    if (err) logIncident(_debugTag, err)
    if (warning) log(_debugTag, warning)

    return data
}
/**
 */
/**
 * @name    getFiatDailyPrice
 * @summary retrieve daily closing price for fiat currencies
 * 
 * @param   {String} symbolFrom 
 * @param   {String} symbolTo   (optional) Default: `USD`
 * @param   {String} outputSize (optional) Default: `compact`
 * @param   {String} dataType   (optional) Default: 'json`
 * 
 * 
 * @example output```javascript 
 * {
 *      "2021-06-02": {
 *          "1. open": "1.22160",
 *          "2. high": "1.22265",
 *          "3. low": "1.21620",
 *          "4. close": "1.22090"
 *      }
 * }
 */
export const getDailyFiatPrice = async (symbolFrom, symbolTo = 'USD', outputSize, dataType) => {
    if (!apiKeys.length) throw new Error('AlphaAdvantage API required')
    if (!symbolFrom) throw new Error('symbolFrom required')
    if (!symbolTo) throw new Error('symbolTo required')

    const dataKey = 'Time Series FX (Daily)'
    const params = {
        apikey: getApiKey(),
        from_symbol: symbolFrom,
        to_symbol: symbolTo,
        function: 'FX_DAILY',
        datatype: dataType || dataTypes.json,
        outputsize: outputSize || outputSizes.compact,
    }
    const url = `${API_BASE_URL}${objToUrlParams(params)}`
    const result = await PromisE.fetch(url, { method: 'get' }, 30000)
    if (dataType === dataTypes.csv) return result

    const _debugTag = `${debugTag} [Daily] [Fiat]`
    const [data, msg, err] = checkAPIError(result, dataKey) || []
    if (msg) logIncident(_debugTag, msg)
    if (err) log(_debugTag, err)

    return data
}

/**
 * @name    updateHistoricalData
 *
 * @param   {CouchDBStorage}    dbHistory       database to store daily prices
 * @param   {CouchDBStorage}    dbCurrencies    database containing list of all currencies and stocks
 * @param   {CouchDBStorage}    dbConf
 * @param   {Boolean}           updateDaily     Default: `true`
 */
export const updateStockDailyPrices = async (...args) => {
    const [dbHistory, dbCurrencies, dbConf, updateDaily = true] = args
    const log = logWithTag(`${debugTag} [Daily]`)

    if (!apiKeys.length) return log('price updates disabled')

    const startTs = new Date()
    try {
        log(
            'Started retrieving daily prices.',
            `Limit per minute: ${LIMIT_MINUTE}.`,
            `Limit per day: ${LIMIT_DAY || 'infinite'}.`,
        )
        if (!isCouchDBStorage(dbHistory, dbCurrencies)) throw new Error(
            'Invalid CouchDBStorage instance supplied: dbHistory'
        )

        const sort = [{
            // Sort by ticker.
            // Change sort direction every day so that even if API limit is hit
            // all currencies will at least be updated every other day.
            // This will only work well if total number of currencies is
            // equal to or less than 2X the daily query limit.
            ticker: new Date().getDate() % 2 === 0
                ? 'asc'
                : 'desc',
        }]
        // only retreive specific types of currencies
        const selector = {
            type: {
                $in: Object.values(currencyTypes),
            }
        }
        //const selector =  { type: currencyTypes.fiat } // retreive only fiat currencies
        const currencies = await dbCurrencies.search(selector, 999999, 0, false, { sort })
        // aggregator configurations including last dates for each currency
        const currencyIds = currencies.map(({ _id }) => _id)
        const allConf = await dbConf.getAll(currencyIds, true)
        const fiatTickers = await fetchSupportedList(currencyTypes.fiat, false)
        const generateQueryData = (currency, index) => {
            const { _id: currencyId, ticker, type } = currency

            // ignore if fiat currency is not supported by AlphaVantage
            if (type === currencyTypes.fiat && !fiatTickers.get(ticker)) return

            const { historyLastDay: lastDate } = allConf.get(currencyId) || {}
            const yesterday = new Date(new Date() - 1000 * 60 * 60 * 24)
                .toISOString()
                .substr(0, 10)
            if (lastDate && lastDate >= yesterday) return

            const size = !isValidDate(lastDate) || (new Date() - new Date(lastDate)) > ms100Days
                ? outputSizes.full
                : outputSizes.compact
            const data = {
                index,
                lastDate,
                ticker,
            }
            switch (type) {
                case currencyTypes.fiat:
                    data.func = getDailyFiatPrice
                    data.funcArgs = [ticker, 'USD', size, dataTypes.json]
                    data.priceKey = '4. close'
                    break
                case currencyTypes.stock:
                    data.func = getDailyStockPrice
                    data.funcArgs = [ticker, size, dataTypes.json]
                    data.priceKey = '5. adjusted close'
                    break
            }
            return data
            // return [index, lastDate, ticker, size, dataTypes.json]
        }
        const maxPerDay = (LIMIT_DAY || LIMIT_MINUTE * 59 * 24) * apiKeys.length
        const queryData = currencies
            .map(generateQueryData)
            .filter(Boolean)
            .slice(0, maxPerDay)

        const processNextBatch = async (batchData) => {
            const results = await PromisE.all(
                batchData.map(d => d.func(...d.funcArgs))
            )
            const currenciesUpdated = new Map()
            const confsUpdated = new Map()
            const priceEntries = results.map((result, i) => {
                const { index, lastDate, priceKey } = batchData[i]
                const currency = currencies[index]
                const { _id: currencyId, ticker, type } = currency
                if (!isObj(result)) return log(`$${ticker}: empty result received`, { result })

                const dates = Object.keys(result)
                    .filter(date => !lastDate || lastDate < date)
                    .sort() // sort ascending

                // no update required
                if (!dates.length) return log(`$${ticker}: no new data received after ${lastDate}`)

                const entries = dates.map(date => ([
                    getHistoryItemId(date, ticker, type),
                    {
                        currencyId,
                        date,
                        ratioOfExchange: usdToROE(
                            parseFloat(result[date][priceKey]) || 0
                        ),
                        source: sourceText,
                    },
                ]))

                const { date: newDate, ratioOfExchange } = entries.slice(-1)[0][1]
                // set most recet price as "current price" for the currency
                currenciesUpdated.set(currencyId, {
                    ...currency,
                    ratioOfExchange,
                    priceUpdatedAt: `${newDate}T00:00:00Z`,
                    source: sourceText,
                })
                // save last date for next execution
                confsUpdated.set(currencyId, {
                    ...confsUpdated.get(currencyId),
                    historyLastDay: newDate,
                })

                return entries
            })
                .flat()
                .filter(Boolean)

            const curLen = currenciesUpdated.size
            if (curLen) {
                log(`Updating ${curLen} currencies`)
                //update latest price of the currency entry
                await dbCurrencies.setAll(currenciesUpdated, false)
            }

            // save daily prices
            log(`Saving ${priceEntries.length} daily price entries`)
            await dbHistory.setAll(new Map(priceEntries), true)
            // save daily prices
            log(`Updating ${confsUpdated.size} config entires`)
            await dbConf.setAll(confsUpdated, false)
            return priceEntries.length
        }

        const len = queryData.length
        const numBatches = parseInt(len / LIMIT_MINUTE)
        let totalSaved = 0
        log(`Updating ${len} tickers`)
        for (let i = 0; i < numBatches; i++) {
            const startIndex = i * LIMIT_MINUTE
            const endIndex = startIndex + LIMIT_MINUTE
            const batchData = queryData.slice(startIndex, endIndex)
            const batchTickers = batchData.map(({ ticker }) => ` $${ticker}`)

            log(`Retrieving prices ${startIndex + 1} to ${endIndex}/${len}:${batchTickers}`)
            try {
                const numSaved = await processNextBatch(
                    batchData.filter(Boolean)
                )
                totalSaved += numSaved || 0
            } catch (err) {
                logIncident(
                    `${debugTag} [Daily]`,
                    'Failed to retrieve daily prices of batch: ',
                    batchTickers,
                    err
                )
            }

            if (i === numBatches - 1) continue

            const secondsDelay = 2 * 60 //(60 / apiKeys.length)
            log(`Waiting ${secondsDelay} seconds to retrieve next batch...`)
            // wait 1 minute and retrieve next batch next batch
            await PromisE.delay(1000 * secondsDelay)
        }

        log('Finished retrieving daily prices. Total saved', totalSaved, 'entries')
    } catch (err) {
        log('Failed to update daily prices', err)
    }
    if (!updateDaily) return
    let delay = ms1Day - (new Date() - startTs)
    const hour = 60 * 60 * 1000
    // if delay is shorter than 1 hour
    if (delay <= hour) delay = hour
    const delayHours = delay / hour
    log(`Waiting ~${delayHours} hours for next execution...`)
    setTimeout(() => {
        updateStockDailyPrices(dbHistory, dbCurrencies)
    }, delay)
}