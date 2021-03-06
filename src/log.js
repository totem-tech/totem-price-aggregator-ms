import { v1 as uuidv1 } from 'uuid'
import PromisE from './utils/PromisE'

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL
const DISCORD_WEBHOOK_AVATAR_URL = process.env.DISCORD_WEBHOOK_AVATAR_URL
const DISCORD_WEBHOOK_USERNAME = process.env.DISCORD_WEBHOOK_USERNAME || 'Totem Price Aggregator Logger'

/**
 * @name    log
 * @summary sugar for console.log with current timestamp prefixed
 */
export default function log(...args) {
    console.log(new Date(), ...args)
}

/**
 * @name    logIncident
 * @summary Send message to discord
 * 
 * @param   {...}      message
 * 
 * @returns {Strirng} incidentID (a new UUID)
 */
export const logIncident = async (...message) => {
    const incidentID = uuidv1()
    log('IncidentID:', incidentID, ...message)
    try {
        message = [...message]
            .map(x => `${x || ''}`)
            .filter(Boolean)
            .join(' ')
        const content = '>>> ' + [
            `**IncidentID:** ${incidentID}`,
            '**Error:** ' + `${message}`.replace('Error:', ''),
        ].join('\n')
        await PromisE.fetch(DISCORD_WEBHOOK_URL, {
            json: true,
            method: 'post',
            body: {
                avatar_url: DISCORD_WEBHOOK_AVATAR_URL,
                content,
                username: DISCORD_WEBHOOK_USERNAME
            }
        }, 30000)
    } catch (err) {
        log('Discord Webhook: failed to send error message. ', err)
    }

    return incidentID
}

export const logWithTag = debugTag => (...args) => log(debugTag, ...args)