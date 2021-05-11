import CoinGecko from 'coingecko-api'
import PromisE from './utils/PromisE'
import { arrSort, isArr, isDefined } from './utils/utils'
import usdToROE from './usdToROE'
import log from './log'

const CoinGeckoClient = new CoinGecko()

/**
 * @name    getCoinGeckoPrices
 * @summary retrieve a list of all ticker prices available in CoinGecko
 * 
 * @returns {Map}
 */
export const getCoinGeckoPrices = async () => {
    log('Retrieving list of coins using CoinGecko API')
    let { data: ids } = await CoinGeckoClient.coins.list()
    if (!isArr(ids)) {
        log('Invalid data received from CoinGecko')
        return
    }
    const symbols = new Map(ids.map(({ id, symbol }) => [id, symbol]))
    ids = ids.map(({ id }) => id)
    const idGroups = new Array(Math.ceil(ids.length / 450))
        .fill(0)
        .map((_, i) => {
            const group = new Array(450)
                .fill(0)
                .map((_, n) => ids[i * 450 + n])
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
            .filter(([id, { usd }]) => isDefined(usd) && isDefined(id))
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
}