import { csvToArr } from './utils/convert'
import CouchDBStorage, { isCouchDBStorage } from './utils/CouchDBStorage'
import DataStorage from './utils/DataStorage'
import PromisE from './utils/PromisE'
import { isObj, isValidDate, objToUrlParams } from './utils/utils'
import { logIncident, logWithTag } from './log'
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
    if (!symbol) throw new Error('Ticker required')
    if (!apiKeys.length) throw new Error('AlphaAdvantage API required')

    const debugTag = `${debugTag} [Daily] [Stock]`
    const log = logWithTag(debugTag)
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

    const data = result[dataKey]
    const err = result['Error Message']
    if (err) {
        logIncident(debugTag, err)
        return log(err)
    }

    const { Note, Information } = result
    if (!isObj(data)) {
        const err = Note || Information || ''
        const limitExceeded = `${err}`.includes('Thank you for using Alpha Vantage!')
        let msg = ''
        if (limitExceeded) {
            msg = 'Exceeded per-minute or daily requests!'
        } else {
            msg = `$${symbol} request failed or invalid data received. Error message: ${err}`
            logIncident(debugTag, msg)
        }

        log(msg)
    }

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

    outputSize = !outputSizes[outputSize]
        ? outputSizes.compact
        : outputSize
    dataType = !dataTypes[dataType]
        ? dataTypes.json
        : dataType

    const log = logWithTag(`${debugTag} [Daily] [Fiat]`)
    const dataKey = 'Time Series FX (Daily)'
    const params = {
        apikey: getApiKey(),
        from_symbol: symbolFrom,
        to_symbol: symbolTo,
        function: 'FX_DAILY',
        datatype: dataType,
        outputsize: outputSize,
    }
    const url = `${API_BASE_URL}${objToUrlParams(params)}`
    const result = await PromisE.fetch(url, { method: 'get' }, 30000)
    if (dataType === dataTypes.csv) return result

    const data = result[dataKey]
    const err = result['Error Message']
    if (err) {
        logIncident(debugTag, err)
        return log(err)
    }

    const { Note, Information } = result
    if (!isObj(data)) {
        const err = Note || Information || ''
        const limitExceeded = `${err}`.includes('Thank you for using Alpha Vantage!')
        let msg = ''
        if (limitExceeded) {
            msg = 'Exceeded per-minute or daily requests!'
        } else {
            msg = `$${symbol} request failed or invalid data received. Error message: ${err}`
            logIncident(`${debugTag} [Daily] [Fiat]`, msg)
        }

        log(msg)
    }

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

        const currencies = await dbCurrencies.search(
            { type: { $in: Object.values(currencyTypes) } },
            // { type: currencyTypes.fiat },
            99999,
            0,
            false,
            { sort: ['ticker'] }, // sort by ticker
        )

        // aggregator configurations including last dates for each currency
        const allConf = await dbConf.getAll(
            currencies.map(({ _id }) => _id),
            true
        )
        const fiatTickers = await fetchSupportedList(currencyTypes.fiat, false)
        const queryData = currencies.map((currency, index) => {
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
        })
            .filter(Boolean)
            .slice(0, LIMIT_DAY || LIMIT_MINUTE * 59 * 24)

        const processNextBatch = async (batchData) => {
            const results = await PromisE.all(
                batchData
                    .filter(Boolean)
                    .map(d => d.func(...d.funcArgs))
            )
            const currenciesUpdated = new Map()
            const confsUpdated = new Map()
            const priceEntries = results.map((result, i) => {
                const { index, lastDate, priceKey } = batchData[i]
                const currency = currencies[index]
                const { _id: currencyId, ticker, type } = currency
                if (!result) return log(ticker, 'empty result received', { result })

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
            const batchTickers = batchData.map(data => ' $' + data.ticker)

            log(`Retrieving prices ${startIndex + 1} to ${endIndex}/${len}:${batchTickers}`)
            try {
                const numSaved = await processNextBatch(batchData)
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

            const secondsDelay = 60 //(60 / apiKeys.length)
            log(`Waiting ${secondsDelay} seconds to retrieve next batch...`)
            // wait 1 minute and retrieve next batch next batch
            await PromisE.delay(1000 * secondsDelay)
        }

        log('Finished retrieving daily prices. Total saved', totalSaved, 'entries')
    } catch (err) {
        log('Failed to update daily prices', err)
    }
    if (!updateDaily) return
    log('Waiting ~24 hours for next execution...')
    const delay = ms1Day - (new Date() - startTs)
    setTimeout(() => {
        updateStockDailyPrices(dbHistory, dbCurrencies)
    }, delay)
}