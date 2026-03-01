import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import xml2js from 'xml2js'
import * as entities from 'entities'

const {
  JELLYFIN_SERVER,
  JELLYFIN_API_KEY,
  JELLYFIN_USER_ID,
  JELLYFIN_MEDIA_ROOT,
  TAUON_XSPF_PATH,
  TAUON_MEDIA_ROOT,
  IGNORE_UNMATCHED,
} = process.env

const JELLYFIN_ORIGIN = new URL(JELLYFIN_SERVER, 'http://localhost').origin
const JELLYFIN_MEDIA_ROOT_REGEX = JELLYFIN_MEDIA_ROOT ? new RegExp(`^${JELLYFIN_MEDIA_ROOT}`, 'm') : null
const TAUON_MEDIA_ROOT_REGEX = TAUON_MEDIA_ROOT ? new RegExp(`^${TAUON_MEDIA_ROOT}`, 'm') : null
const HEADERS = {
  'Content-Type': 'application/json'
}

const xmlParser = new xml2js.Parser()

function buildJellyfinHref(url) {
  const urlObject = new URL(url, JELLYFIN_ORIGIN)
  const querySlug = `ApiKey=${JELLYFIN_API_KEY}&userId=${JELLYFIN_USER_ID}`
  let href = urlObject.href
  if (urlObject.search) href = `${href}&${querySlug}`
  else href = `${href}?${querySlug}`
  return href
}

function buildPath(parsedPath) {
  return `${parsedPath.dir}/${parsedPath.base}`
}

async function get(url) {
  const href = buildJellyfinHref(url)
  try {
    const resp = await fetch(href, {
      method: 'GET',
      headers: HEADERS,
    })
    return resp.json()
  } catch (err) {
    console.error()
  }
}

async function post(url, body) {
  const href = buildJellyfinHref(url)
  try {
    const resp = await fetch(href,{
      method: 'POST',
      headers: HEADERS,
      body,
    })
    return resp.json()
  } catch (err) {
    console.error()
  }
}



let xspfPlaylist = []
let jellyfinMusic = []

// indexes
const jMusicTitleMap = {}
const jMusicPathMap = {}
const jMusicTitleMapConflicts = {}

const trackMatches = []

async function loadXspf() {
  console.log('loadXspf: loading .xspf playlist')
  const filepath = path.resolve(TAUON_XSPF_PATH)
  const xml = await fs.readFile(filepath, { encoding: 'utf8' })
  const result = await xmlParser.parseStringPromise(xml)
  xspfPlaylist = result.playlist.trackList[0].track
}

async function getJellyfinMusic() {
  console.log('getJellyfinMusic: fetching Jellyfin music library')
  const data = await get(`Items?fields=Genres&fields=DateCreated&fields=MediaSources&fields=People&enableImages=False&includeItemTypes=Audio&includeItemTypes=Playlist&recursive=True`)
  jellyfinMusic = data.Items

  // indexing
  console.log('  - getJellyfinMusic: indexing library')
  for (const track of jellyfinMusic) {
    // name
    if (track.Name) {
      if (!jMusicTitleMap[track.Name]) {
        jMusicTitleMap[track.Name] = track
      } else {
        jMusicTitleMapConflicts[track.Name] = true
      }
    }
    // path
    if (track.MediaSources?.[0]?.Path) {
      // normalise and truncate root
      const parsedPath = path.parse(track.MediaSources[0].Path)
      let filepath = buildPath(parsedPath)
      if (JELLYFIN_MEDIA_ROOT_REGEX) filepath = filepath.replace(JELLYFIN_MEDIA_ROOT_REGEX, '')
      jMusicPathMap[filepath] = track
    }
  }
}

function matchXspfJellyfin() {
  console.log('matchXspfJellyfin: matching playlist with library')
  // console.log(xspfPlaylist[0], jellyfinMusic[0])
  // console.log('jMusicTitleMap', Object.keys(jMusicTitleMap))
  // console.log('jMusicTitleMapConflicts', Object.keys(jMusicTitleMapConflicts))
  // console.log('jMusicPathMap', Object.keys(jMusicPathMap))
  for (let i = 0; i < xspfPlaylist.length; i++) {
    const track = xspfPlaylist[i]
    // title, then path if unavailable or duplicated
    const decodedTitle = track.title ? decodeURIComponent(
      entities.decodeXML(track.title)
    ) : null
    
    // title
    if (decodedTitle && jMusicTitleMap[decodedTitle] && !jMusicTitleMapConflicts[decodedTitle]) {
      trackMatches.push(jMusicTitleMap[track.title])
      continue
    }

    // path
    if (track.location?.[0]) {
      const parsedPath = path.parse(
        decodeURIComponent(
          entities.decodeXML(track.location[0])
        )
      )
      console.warn(`  - matchXspfJellyfin: duplicated or unnamed track (${parsedPath.base}), matching on path`)
      let filepath = buildPath(parsedPath)
      if (TAUON_MEDIA_ROOT_REGEX) filepath = filepath.replace(TAUON_MEDIA_ROOT_REGEX, '')
      if (jMusicPathMap[filepath]) {
        trackMatches.push(jMusicPathMap[filepath])
        continue
      } else {
        console.warn(`  - matchXspfJellyfin: couldnt match path for ${parsedPath.base}!`)
      }
    }

    // no match
    if (!IGNORE_UNMATCHED) {
      throw(new Error('matchXspfJellyfin: exiting! To ignore unmatched, pass env IGNORE_UNMATCHED as true'))
    }
  }
  console.log(`  - matchXspfJellyfin: matched ${trackMatches.length}!`)
}

async function favouriteMatches() {
  console.log('favouriteMatches: favouriting tracks')
  const promises = []
  for (const track of trackMatches) {
    promises.push(post(`UserFavoriteItems/${track.Id}`))
  }
  const result = await Promise.all(promises)
  console.log(`  - favouriteMatches: favourited ${result.filter(item => !!item).length} tracks!`)
}

async function main() {
  try {
    await Promise.all([
      loadXspf(),
      getJellyfinMusic(),
    ])
    matchXspfJellyfin()
    await favouriteMatches()
  } catch(err) {
    console.error(err)
  }
}
main()
