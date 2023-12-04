import {
  error, // creates error responses
  json, // creates JSON responses
  html, // creates HTML responses
  Router, // the ~440 byte router itself
} from "itty-router";
import { create_mosaic } from "./collage/pkg/collage";
import Constants from "./constants";
import { getPostInfo } from "./util/requests.js";

// create a new Router
const router = Router();

async function handleGeneric(req, _env, event) {
  const { encodedUrl } = req.params;
  const mediaUrl = decodeURIComponent(encodedUrl);
  const urls = mediaUrl.split(",");

  if (urls.length == 0) return error(400);

  // validate the URLs

  for (const media of urls) {
    const url = new URL(media);
    const parts = url.hostname.split(".");
    const domain = parts.length > 1 ? parts[parts.length - 2] : null;
    if (domain !== "cdninstagram")
      return json({
        error: "Invalid domain",
        message: "Please use a valid Instagram CDN URL",
        url: mediaUrl,
        domain: domain,
      });
  }

  const cache = caches.default;
  const cacheKey = req;
  let response = undefined; // await cache.match(cacheKey);

  if (response) {
    return response;
  } else {
    if (urls.length > 1) {
      const images = await Promise.all(
        urls.map(async (url) => {
          const response = await fetch(url);
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          return new Uint8Array(arrayBuffer);
        })
      );
      console.log("creating mosaic");
      const layout = create_mosaic(images);
      console.log("created mosaic");
      const image = await layout.buffer;
      response = new Response(image, {
        headers: {
          "Content-Type": "image/jpeg",
        },
      });
    } else {
      response = await fetch(urls[0]);
    }

    event.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
}

async function handleImage(req, _env, event) {}

const fetchFromProxy = (url: string, proxy: "video" | "image") => {
  const encodedUrl = encodeURIComponent(url);

  return `https://gginstagram.com/${proxy}/${encodedUrl}`;
};

const allowedCountries = ["US", "GB", "CA"];

const allowedASNs = [396982];

const embed = async (req, env, event) => {
  const { id, index } = req.params;
  const { bypass, c } = req.query;
  const url = new URL(req.url);

  const userAgent = req.headers.get("User-Agent") || "";
  const isBotUA = userAgent.match(Constants.BOT_UA_REGEX) !== null;

  const asn = req.cf.asn;
  const country = req.cf.country;

  const targetUrl = `https://www.instagram.com${url.pathname}`;
  if (!isBotUA && !bypass) {
    return Response.redirect(targetUrl, 302);
  }

  const cacheKey = req;
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    return cachedResponse;
  }

  const sendElseWhere = `https://ddinstagram.com${url.pathname}`;
  if (!allowedASNs.includes(asn) || !allowedCountries.includes(country) || c) {
    const response = await fetch(sendElseWhere, {
      headers: {
        "User-Agent": "bot",
      },
    });
    const body = await response.text();
    const replacedVideos = body.replace(
      /\/videos\//g,
      "https://ddinstagram.com/videos/"
    );
    const replacedImages = replacedVideos.replace(
      /\/images\//g,
      "https://ddinstagram.com/images/"
    );

    return html(replacedImages);
  }

  const {
    videoUrl,
    imageUrls,
    caption,
    likeCount,
    commentCount,
    username,
    pages,
    json,
  } = (await getPostInfo(id, index, env)) ?? {};
  const truncatedCaption = caption ? caption.split("\n")[0] : "";
  const text = encodeURIComponent(
    `${
      pages && pages > 1 ? `${index ?? 1}/${pages} 🖼️` : ``
    } ${likeCount} ❤️  ${commentCount} 💬`
  );
  const headers = [
    `<meta charset="utf-8"/>`,
    `<link rel="canonical" href="${targetUrl}"/>`,
    `<meta property="og:url" content="${targetUrl}"/>`,
    `<meta property="theme-color" content="#E1306C"/>`,
    `<meta property="twitter:site" content="@${username}"/>`,
    `<meta property="twitter:creator" content="@${username}"/>`,
    `<meta property="twitter:title" content="@${username}"/>`,
    `<meta property="og:description" content="${truncatedCaption}"/>`,
    `	<link rel="alternate"
		href="https://gginstagram.com/faux?text=${text}&url=${url.pathname}"
		type="application/json+oembed" title=@${username}>`,
    `<meta property="og:site_name" content="PotatoInstaFix"/>`,
  ];

  if (videoUrl) {
    const proxyVideo = fetchFromProxy(videoUrl, "video");
    headers.push(`<meta property="og:video" content="${proxyVideo}"/>`);
    headers.push(`<meta property="og:video:type" content="video/mp4"/>`);
    headers.push(`<meta property="twitter:player" content="${proxyVideo}"/>`);
    headers.push(`<meta property="twitter:player:width" content="0"/>`);
    headers.push(`<meta property="twitter:player:height" content="0"/>`);
    headers.push(
      `<meta property="twitter:player:stream" content="${proxyVideo}"/>`
    );
    headers.push(
      `<meta property="twitter:player:stream:content_type" content="video/mp4"/>`
    );
    headers.push(`<meta name="twitter:card" content="player"/>`);
  } else {
    const proxyImage = fetchFromProxy(
      imageUrls.splice(0, 4).join(","),
      "image"
    );
    headers.push(`<meta property="og:image" content="${proxyImage}"/>`);
    headers.push(`<meta property="twitter:image" content="${proxyImage}"/>`);
    headers.push(`<meta name="twitter:card" content="summary_large_image"/>`);
  }

  const response = html(`
  <!DOCTYPE html>
    <html>
   <head>
   ${headers.join("\n")}
   </head>
      </html>
        `);
  event.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};

const generateFakeEmbed = async (req) => {
  const { text, url } = req.query;
  if (!text || !url) return error(400);
  return json({
    author_name: decodeURIComponent(text),
    author_url: `https://instagram.com${decodeURIComponent(url)}`,
    provider_name: "PotatoInstaFix",
    provider_url: "https://github.com/ThePotato97/InstaFixerCF",
    title: "Instagram",
    type: "link",
    version: "1.0",
  });
};

const handleError = (error) => {
  console.error(error); // Log the error for server-side visibility
  const code = error.status || 500;
  // Return a generic error message
  const htmlResponse = `
    <!DOCTYPE html>
    <html>
      <head>
      	<meta charset="utf-8" />
	      <meta name="theme-color" content="#CE0071" />
	      <meta name="twitter:title" content="PotatoInstaFix" />
	      <meta property="og:url" content="https://instagram.com/reel/CzqaXfT6qdk6/" />
        <meta name="description" content="An error occurred: ${code}">
        <meta property="og:title" content="Error ${code}">
        <meta property="og:description" content="Post might not be available ${code}">
      </head>
      <body>
        <h1>Internal Server Error</h1>
        <!-- Additional HTML content for the error page -->
      </body>
    </html>
  `;
  return html(htmlResponse);
};

router.get("/video/:encodedUrl", handleGeneric);
router.get("/image/:encodedUrl", handleGeneric);
router.get("/p/:id/:index", embed);
router.get("/p/:id", embed);
router.get("/faux/", generateFakeEmbed);
router.get("/reel/:id", embed);
router.all("*", () => {
  return Response.redirect("https://github.com/ThePotato97/InstaFixerCF", 302);
});

// Fetch event listener
export default {
  fetch: (request, ...args) =>
    router.handle(request, ...args).catch(handleError),
};
