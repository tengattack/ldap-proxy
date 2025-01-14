
const process = require('process')
const express = require('express')
const bodyParser = require('body-parser')

const { queryDb } = require('./db')

const api = express()
let apiKey = null
let mappingConfig = null

api.use(bodyParser.json())
api.use(bodyParser.urlencoded({ extended: true })) 

function errorResp(code, message) {
  return { code, message, data: null }
}

function successResp(data, message = '') {
  return { code: 0, message, data }
}

api.post('/ldap-proxy/add-user', async (req, res) => {
  const headerApiKey = req.header('X-Api-Key')
  if (!headerApiKey || headerApiKey !== apiKey) {
    res.status(403).json(errorResp(403, 'no api key'))
    return
  }
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json(errorResp(400, 'params error'))
    return
  }
  let { account_name, mapping_group } = req.body
  if (!account_name || !mapping_group) {
    res.status(400).json(errorResp(400, 'params error'))
    return
  }
  if (mappingConfig.mapping_group_suffix) {
    mapping_group += ', ' + mappingConfig.mapping_group_suffix
  }
  const nowUnix = Math.floor(Date.now() / 1000)
  try {
    await queryDb('INSERT INTO lp_mapping_users (`create_time`, `modified_time`, `account_name`, `search_base`, `mapping_group`)'
        + ' VALUES (?, ?, ?, ?, ?)',
      [nowUnix, nowUnix, account_name, mappingConfig.search_base, mapping_group]
    )
  } catch (e) {
    res.status(500).json(errorResp(500, 'server internal error: ' + e.message))
    return
  }

  // restart server
  setTimeout(() => {
    process.exit(2)
  }, 2000)

  res.json(successResp(null, 'success'))
})

api.post('/ldap-proxy/restart', async (req, res) => {
  // restart server
  setTimeout(() => {
    process.exit(2)
  }, 2000)

  res.json(successResp(null, 'success'))
})

function runApiServer(config, mapping) {
  apiKey = config['key']
  if (typeof apiKey !== 'string' || !apiKey) {
    throw new Error('invalid api key')
  }
  mappingConfig = config['mapping']
  api.listen(config['port'], function () {
    console.log('API server listening at :' + config['port'])
  })
}

exports.runApiServer = runApiServer
