import CoinGecko from 'coingecko-api'
import DataStorage from './utils/DataStorage'
import PromisE from './utils/PromisE'
import { arrSort, isArr, isDefined, isInteger, isValidNumber } from './utils/utils'
import log from './log'
import { getHistoryItemId, usdToROE } from './utils'
import CouchDBStorage from './utils/CouchDBStorage'

const delaySeconds = parseInt(process.env.CG_Throttle_Delay_Seconds || 10)
const coinsList = new DataStorage('coingecko-coins-list.json')
const cgClient = new CoinGecko()
const cryptoType = 'cryptocurrency'
const moduleName = 'CoinGecko'
const debugTag = `[${moduleName}]`
export const sourceText = 'coingecko.com'

/**
 * @name    getCoinsList
 * @summary get a list of all coins available on CoinGecko
 * 
 * @param   {Boolean} forceUpdate 
 * 
 * @returns {Map}
 */
export const getCoinsList = async (forceUpdate = false) => {
    let list = coinsList.getAll()
    if (list.size && !forceUpdate) return list

    log(debugTag, 'Retrieving list of supported coins')
    let { data } = await cgClient.coins.list()
    if (!isArr(data)) throw log(debugTag, 'Invalid data received from CoinGecko')

    data = new Map(
        data.map(({ id, name, symbol }) => [
            symbol,
            { id, name }
        ])
    )
    coinsList.setAll(data, true)
    return data
}

/**
 * @name    getCoinGeckoPrices
 * @summary retrieve a list ticker prices from CoinGecko
 * 
 * @param   {Array} symbols a list of cryptcurrency symbols
 * 
 * @returns {Map}
 */
export const getLatestPrices = async (symbols = []) => {
    log(debugTag, 'Retrieving list of coins')

    let supprtedCoins
    try {
        supprtedCoins = await getCoinsList(false)
    } catch (err) {
        log(debugTag, 'Failed to retrieve coins list', err)
        return
    }

    // exclude any currency that's not supported
    let coins = symbols
        .map(symbol => {
            const { id } = supprtedCoins.get(symbol.toLowerCase()) || {}
            return id && [id, symbol]
        })
        .filter(Boolean)
        .sort()
    const ids = coins.map(([id]) => id)
    coins = new Map(coins)

    // create group of IDs for batch requests
    // Using over ~450 may cause the request to fail
    const maxPerGroup = 400
    const idGroups = new Array(Math.ceil(ids.length / maxPerGroup))
        .fill(0)
        .map((_, i) => {
            const group = new Array(450)
                .fill(0)
                .map((_, n) => ids[i * 450 + n])
                .filter(Boolean)
            return group
        })

    try {
        let results = await PromisE.all(
            idGroups.map(ids =>
                cgClient.simple.price({
                    ids,
                    vs_currencies: 'usd',
                    include_last_updated_at: true,
                    include_market_cap: true,
                })
            )
        )
        results = results
            .map(({ data }) =>
                Object.keys(data).map(id =>
                    [id, data[id]]
                )
            )
            .flat()
            // make sure there's valid price
            .filter(([id, { usd }]) =>
                isDefined(usd) && isDefined(id)
            )
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
                coins.get(entry.id).toUpperCase(),
                { ...entry, rank: i + 1 },
            ])
        return new Map(results)
    } catch (err) {
        log(debugTag, `Failed to retrieve price. ${err}`, err)
        return
    }
}

/**
 * @name    getPriceHistory
 * @summary get all available daily closing prices for a specific ticker
 * 
 * @param   {String}       symbol       Ticker symbol
 * @param   {Date|String}  dateFrom     (optional) Range start date. If string must be YYYY-MM-DD format.
 *                                      Default/falsy: `"2009-01-01"`
 * @param   {Date|String}  dateTo       (optional) Range end date. If string must be YYYY-MM-DD format.
 *                                      Default/falsy: `new Date()`
 * @param   {String}       vsCurrency   (optional) Target currency.
 *                                      Default: `usd`
 * 
 * @returns {Map}
 */
export const getPriceHistory = async (currencyId, coinId, dateFrom, dateTo, vsCurrency = 'usd') => {
    // if (!dateFrom) return [
    //     ...await getPriceHistory(currencyId, coinId, '2009-01-01', '2015-01-01', vsCurrency),
    //     // PromisE.delay(3000),
    //     ...await getPriceHistory(currencyId, coinId, '2015-01-01', '2018-01-01', vsCurrency),
    //     ...await getPriceHistory(currencyId, coinId, '2018-01-01', dateTo, vsCurrency),
    // ]
    dateFrom = new Date(dateFrom || '2009-01-01')
    const to = new Date(dateTo || new Date())
    const days91 = 1000 * 60 * 60 * 24 * 91 // 91 days in milliseconds
    // make sure date range is 90+ days to avoid getting hourly rates
    const from = (to - dateFrom) > days91
        ? dateFrom
        : new Date(to - days91)
    const params = {
        vs_currency: vsCurrency,
        from: `${parseInt(from.getTime() / 1000)}`,
        to: `${parseInt(to.getTime() / 1000)}`,
    }
    const result = await cgClient.coins
        .fetchMarketChartRange(coinId, params)
    const { error, market_caps, prices } = (result || {}).data || {}

    if (error || !isArr(prices) || !isArr(market_caps)) {
        log(debugTag, params, `CoinId - ${coinId}: failed to retrieve price history. ${error || ''}`)
        return
    }
    dateFrom = dateFrom.toISOString().substr(0, 10)
    return prices
        .map(([ts, priceUsd], i) => {
            // YYYY-MM-DD
            let date = new Date(ts).toISOString()
            if (date.substr(11, 2) > 22) {
                // if price updated after 10PM set to next day
                date = new Date(
                    new Date(date.substr(0, 10)).getTime()
                    + 1000 * 60 * 60 * 24
                ).toISOString()
            }
            date = date.substr(0, 10)
            // exclude any data before the range start date (dateFrom)
            if (date < dateFrom) return

            const [_, marketCapUSD] = market_caps.find(([mts]) => mts === ts) || []
            return [
                getHistoryItemId(date, currencyId),
                {
                    currencyId,
                    date,
                    marketCapUSD,
                    ratioOfExchange: usdToROE(priceUsd),
                    source: sourceText,
                }
            ]
        })
        .filter(Boolean)

}

/**
 * @name    updateCryptoDailyPrices
 * @summary retrieve historical daily closing prices of all supported cryptocurrencies from CoinGecko
 * 
 * @param   {CouchDBStorage}    dbDailyHistory
 * @param   {CouchDBStorage}    dbCurrencies
 * @param   {CouchDBStorage}    dbConf
 * @param   {Boolean}           updateDaily
 */
export const updateCryptoDailyPrices = async (dbDailyHistory, dbCurrencies, dbConf, updateDaily = true) => {
    const debugTag = `[${moduleName}] [Daily]`
    try {
        log(debugTag, 'Started retrieving cyrpto daily prices')
        const cgCoins = await getCoinsList(false)
        const cryptoCoins = await dbCurrencies.search(
            { type: cryptoType },
            9999,
            0,
            false,
            { sort: [{ 'name': 'desc' }] },
        )

        // aggregator configurations including last dates for each currency
        const allConf = await dbConf.getAll(
            cryptoCoins.map(({ _id }) => _id),
            true
        )
        // mutually supported coins
        const coinsToFetch = cryptoCoins
            .map(({ _id: currencyId, ticker }) => {
                const { id: coinId } = cgCoins.get(ticker.toLowerCase()) || {}
                if (!coinId) return

                const { historyLastDay } = allConf.get(currencyId) || {}
                const today = new Date()
                    .toISOString()
                    .substr(0, 10)
                if (historyLastDay === today) return

                return [currencyId, coinId, historyLastDay]
            })
            .filter(Boolean)

        const len = coinsToFetch.length
        log(debugTag, `Fetching daily prices for ${len} currencies`)

        for (let i = 0; i < len; i++) {
            try {
                const [currencyId, coinId, historyLastDay] = coinsToFetch[i]
                const coinTag = `$${coinId} ${i + 1}/${len}:`

                // retrieve latest entry for each currency

                // const { date } = (await dbDailyHistory.find(
                //     { currencyId },
                //     {
                //         sort: [
                //             { date: 'desc' },
                //             { currencyId: 'desc' }
                //         ]
                //     },
                // )) || {}
                // const isToday = historyLastDay && new Date(historyLastDay)
                //     .toISOString()
                //     .substr(0, 10) === new Date()
                //         .toISOString()
                //         .substr(0, 10)

                // if (historyLastDay && isToday) {
                //     log(debugTag, coinTag, 'already updated')
                //     continue
                // }
                const result = await getPriceHistory(currencyId, coinId, historyLastDay)

                log(debugTag, coinTag, `saving ${result.length} daily crypto price entries`)
                await dbDailyHistory.setAll(new Map(result), false)
                const newDate = result
                    .map(([_, { date }]) => date)
                    .sort()[0]
                newDate && await dbConf.set(currencyId, {
                    ...confsUpdated.get(currencyId),
                    historyLastDay: newDate,
                })

                if (i === len - 1) continue // last item
            } catch (err) {
                log(debugTag, coinTag, err)
            }

            log(debugTag, `Waiting ${delaySeconds} seconds to avoid being throttled`)
            await PromisE.delay(delaySeconds * 1000)
        }

        len && log(debugTag, 'Finished retrieving daily crypto prices')
    } catch (err) {
        log(debugTag, 'Failed to update daily crypto prices', err)
    }

    if (!updateDaily) return
    log(debugTag, 'Waiting 24 hours before next execution....')
    setTimeout(() => updateCryptoDailyPrices(
        dbDailyHistory,
        dbCurrencies,
        updateDaily,
    ), 1000 * 60 * 60 * 24)
}