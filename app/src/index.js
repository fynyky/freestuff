// -----------------------------------------------------------------------------
// Dependencies
// -----------------------------------------------------------------------------
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import express from 'express'
import flash from 'express-flash'
import session from 'express-session'
import url from 'url'
import minio from 'minio'
import multer from 'multer'
import passport from 'passport'
import path from 'path'
import pg from 'pg'
import redis from 'redis'
import connectRedis from 'connect-redis'
import { v4 as uuid } from 'uuid'
import waitOn from 'wait-on'
import Auth from './auth.js'

// -----------------------------------------------------------------------------
// Environmental Variables & Constants
// -----------------------------------------------------------------------------
const APP_PORT = process.env.APP_PORT ? process.env.APP_PORT : 1337
const SESSION_SECRET = process.env.SESSION_SECRET
  ? process.env.SESSION_SECRET
  : 'keyboardCat'
const DB_HOST = process.env.DB_HOST ? process.env.DB_HOST : 'db'
const DB_PORT = process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432
const DB_USER = process.env.DB_USER ? process.env.DB_USER : 'postgres'
const DB_PASSWORD = process.env.DB_PASSWORD
  ? process.env.DB_PASSWORD
  : 'postgres'
const DB_NAME = process.env.DB_NAME ? process.env.DB_NAME : 'postgres'
const DB_SSL = process.env.DB_SSL ? (process.env.DB_SSL === 'true') : false
const BLOB_HOST = process.env.BLOB_HOST ? process.env.BLOB_HOST : 'blobstore'
const BLOB_PORT = process.env.BLOB_PORT ? parseInt(process.env.BLOB_PORT) : 9000
const BLOB_USER = process.env.BLOB_USER ? process.env.BLOB_USER : 'minioadmin'
const BLOB_PASSWORD = process.env.BLOB_PASSWORD ? process.env.BLOB_PASSWORD : 'minioadmin'
const BLOB_BUCKET = process.env.BLOB_BUCKET ? process.env.BLOB_BUCKET : 'uploads'
const BLOB_PATH = process.env.BLOB_PATH ? process.env.BLOB_PATH : 'http://localhost:9000/uploads/'
const CACHE_HOST = process.env.CACHE_HOST ? process.env.CACHE_HOST : 'cache'
const CACHE_PORT = process.env.CACHE_PORT ? parseInt(process.env.CACHE_PORT) : 6379
const CACHE_PASSWORD = process.env.CACHE_PASSWORD ? process.env.CACHE_PASSWORD : 'foobared'
const CACHE_SSL = process.env.CACHE_SSL ? (process.env.CACHE_SSL === 'true') : false

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------
dayjs.extend(relativeTime)

// Setup the database connection
console.log(`Waiting on database availability ${DB_HOST}:${DB_PORT}`)
await waitOn({
  resources: [`tcp:${DB_HOST}:${DB_PORT}`]
})
const db = new pg.Pool({
  host: DB_HOST,
  port: DB_PORT,
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  ssl: DB_SSL
})
console.log(`Database available at ${DB_HOST}:${DB_PORT}`)

// Setup blobstore connection
console.log(`Waiting on blobstore availability ${BLOB_HOST}:${BLOB_PORT}`)
await waitOn({
  resources: [`tcp:${BLOB_HOST}:${BLOB_PORT}`]
})
const minioClient = new minio.Client({
  endPoint: BLOB_HOST,
  port: BLOB_PORT,
  accessKey: BLOB_USER,
  secretKey: BLOB_PASSWORD,
  useSSL: false
})
console.log(`Blobstore available at ${BLOB_HOST}:${BLOB_PORT}`)
// Stores a file with a random filename
class MinioMulterStorage {
  #client
  #bucket
  constructor (opts) {
    this.#client = opts.client
    this.#bucket = opts.bucket
  }

  _handleFile (req, file, cb) {
    const key = uuid()
    this.#client.putObject(
      this.#bucket,
      key,
      file.stream,
      (err, result) => {
        if (err) cb(err)
        cb(null, {
          bucket: this.#bucket,
          key,
          etag: result.etag,
          versionId: result.versionId
        })
      }
    )
  }

  _removeFile (req, file, cb) {
    this.#client.removeObject(file.bucket, file.key, cb)
  }
}
// Multer for express middleware it
const upload = multer({
  storage: new MinioMulterStorage({
    client: minioClient,
    bucket: BLOB_BUCKET
  })
})

// Setup cache connection
console.log(`Waiting on cache availability ${CACHE_HOST}:${CACHE_PORT}`)
await waitOn({
  resources: [`tcp:${CACHE_HOST}:${CACHE_PORT}`]
})
const RedisStore = connectRedis(session)
const redisClient = redis.createClient({
  legacyMode: true,
  url: CACHE_SSL 
    ? `rediss://default:${CACHE_PASSWORD}@${CACHE_HOST}:${CACHE_PORT}`
    : `redis://default:${CACHE_PASSWORD}@${CACHE_HOST}:${CACHE_PORT}`
})
await redisClient.connect()
console.log(`Cache available ${CACHE_HOST}:${CACHE_PORT}`)

// // Setup the main application stack
console.log('Initializing app server')
const app = express()
// // Find the path to the staic file folder
const filePath = url.fileURLToPath(import.meta.url)
const serverPath = path.dirname(filePath)
const viewPath = path.join(serverPath, 'views')
const publicPath = path.join(serverPath, 'public')
// Configure middleware
app.set('view engine', 'pug')
app.set('views', viewPath)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(flash())
app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false
  })
)
app.use(passport.initialize())
app.use(passport.session())
const auth = new Auth(passport, db).init()

// // -----------------------------------------------------------------------------
// // Web Server
// // -----------------------------------------------------------------------------
app.use(express.static(publicPath))

app.get('/', async (req, res) => {
  // // Charity users see everthing
  // // Logged in users see can their own posts even if less than 48 hours
  // // Non logged in users only see results older than 48 hours
  // let result
  // if (req.user?.charity) {
  //   result = await db.query(`
  //     SELECT listing_id, listing_description, listing_location, listing_created_at, listing_image_key 
  //     FROM listing JOIN account 
  //     ON listing_owner_id = account_id
  //     ORDER BY listing_created_at DESC
  //   `)
  // } else if (req.user?.id) {
  //   result = await db.query(`
  //     SELECT listing_id, listing_description, listing_location, listing_created_at, listing_image_key 
  //     FROM listing JOIN account 
  //     ON listing_owner_id = account_id
  //     WHERE (listing_created_at < NOW() - INTERVAL '48 hours')
  //     OR (listing_owner_id = $1)
  //     ORDER BY listing_created_at DESC
  //   `, [req.user.id])
  // } else {
  //   result = await db.query(`
  //     SELECT listing_id, listing_description, listing_location, listing_created_at, listing_image_key 
  //     FROM listing JOIN account 
  //     ON listing_owner_id = account_id
  //     WHERE listing_created_at < NOW() - INTERVAL '48 hours'
  //     ORDER BY listing_created_at DESC
  //   `)
  // }
  // // Non charity users only see stuff older than 48 hours
  // const listings = result.rows.map(row => {
  //   return {
  //     id: row.listing_id,
  //     description: row.listing_description,
  //     timestamp: dayjs(row.listing_created_at).fromNow(),
  //     location: row.listing_location,
  //     imageURL: `${BLOB_PATH}${row.listing_image_key}`
  //   }
  // })
  const listings = []
  res.render('index', { listings, user: req.user })
})

// app.get('/account', auth.check('/login'), async (req, res) => {
//   res.render('account', { user: req.user })
// })

// app.get('/listing/:listingId', auth.check('/login'), async (req, res) => {
//   const result = await db.query(`
//     SELECT 
//       listing_owner_id,
//       listing_description,
//       listing_category,
//       listing_location,
//       listing_contact,
//       listing_collection,
//       listing_image_key,
//       listing_created_at
//     FROM listing JOIN account 
//     ON listing_owner_id = account_id
//     WHERE listing_id = $1
//   `, [ req.params.listingId ])
//   const listing = {
//     id: result.rows[0].listing_id,
//     description: result.rows[0].listing_description,
//     category: result.rows[0].listing_category,
//     location: result.rows[0].listing_location,
//     contact: result.rows[0].listing_contact,
//     collection: result.rows[0].listing_collection,
//     imageURL: `${BLOB_PATH}${result.rows[0].listing_image_key}`,
//     timestamp: dayjs(result.rows[0].listing_created_at).fromNow()
//   }
//   res.render('listing', { user: req.user, listing })
// })

// app.get('/listing', auth.check('/login'), async (req, res) => {
//   res.render('listing', { user: req.user })
// })

// app.post('/listing', auth.check('/login'), upload.single('file'), async (req, res) => {
//   const owner = req?.user?.id
//   const description = req?.body?.description
//   const category = req?.body?.category
//   const location = req?.body?.location
//   const collection = req?.body?.collection
//   const contact = req?.body?.contact
//   const image = req?.file?.key
//   // Validate inputs. Only create a new object if all fields are set
//   if (
//     owner === undefined ||
//     description === undefined ||
//     category === undefined ||
//     location === undefined ||
//     collection === undefined ||
//     contact === undefined ||
//     image === undefined
//   ) {
//     res.sendStatus(422)
//     return
//   }
//   const query = `
//     INSERT INTO listing(
//       listing_owner_id,
//       listing_description,
//       listing_category,
//       listing_location,
//       listing_collection,
//       listing_contact,
//       listing_image_key
//     ) 
//     VALUES ($1, $2, $3, $4, $5, $6, $7) 
//     RETURNING *
//   `
//   await db.query(query, [
//     owner,
//     description,
//     category,
//     location,
//     collection,
//     contact,
//     image
//   ])
//   res.redirect('/')
// })

// app.get('/login', auth.authenticate())

// app.get('/callback', auth.authenticate(), async (req, res) => {
//   if (req.session.targetUrl) res.redirect(req.session.targetUrl)
//   else res.redirect('/')
// })

// app.post(
//   '/login',
//   auth.checkNot('/'),
//   (req, res, next) => {
//     let targetUrl = '/'
//     if (req.session.targetUrl) {
//       targetUrl = req.session.targetUrl
//       delete req.session.targetUrl
//     }
//     return auth.authenticate()(req, res, next)
//   }
// )

// app.post('/logout', (req, res, next) => {
//   req.logout((err) => {
//     if (err) next(err)
//     else res.redirect('/')
//   })
// })

// -----------------------------------------------------------------------------
// Deployment
// -----------------------------------------------------------------------------
app.listen(APP_PORT, () => console.log(`Server listening on port ${APP_PORT}`))
