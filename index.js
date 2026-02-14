import fs from "fs";
import fsPromise from "fs/promises";
import { parse } from "node-html-parser";
import { Readable } from "stream";

const downloadThreads = 6;
const nyaa_max_results = 1000;
const max_retries = 2;

const alphabet = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
];

(async () => {
  var providedUrl = process.argv.slice(2)[0];
  var providerType = process.argv.slice(3)[0];
  let downloadLinks = [];
  let retryDownloadLinks = [];

  const appendLinks = async (href, letter, isSameLetter) => {
    const url = new URL(href);
    if (!isSameLetter && letter) {
      url.searchParams.set(
        "q",
        `"${url.searchParams.get("q").split(" ")[0]}+${letter}"+${url.searchParams.get("q").split(" ")[1]}`,
      );

      url.search = decodeURIComponent(url.search);
    } else if (!isSameLetter) {
      url.searchParams.set(
        "q",
        `${url.searchParams.get("q").split(" ")[0]} +-${alphabet.map((localLetter) => `"${url.searchParams.get("q").split(" ")[0]}+${localLetter}"`).join("|")}+${url.searchParams.get("q").split(" ")[1]}`,
      );

      url.search = decodeURIComponent(url.search);
    }

    try {
      console.clear();
      console.log(
        `(${downloadLinks.length}) Retrieving links in alphanumerical order (${letter})`,
      );
      const { body: localBody } = await fetch(url);

      const localPlainTextBody = await new Response(localBody).text();

      const localDocument = parse(localPlainTextBody);

      const tooManyRequests = localPlainTextBody.includes(
        "429 Too Many Requests",
      );
      if (tooManyRequests) {
        console.log("429: Too many requests, retry in 5 minutes");
        setTimeout(
          () => {
            appendLinks(href, letter, isSameLetter);
          },
          1000 * 60 * 5,
        );
        Promise.resolve();
        return;
      }

      const noTorrents = localPlainTextBody.includes(" 0 results");
      if (noTorrents) {
        Promise.resolve();
        return;
      }
      const maxResults = localPlainTextBody.includes(
        `${nyaa_max_results} results`,
      );
      if (maxResults) {
        for (let j = 0; j < alphabet.length; j++) {
          await appendLinks(href, letter + alphabet[j], isSameLetter);
        }
        Promise.resolve();
        return;
      }
      const localLinks = localDocument.getElementsByTagName("a");

      [].slice.call(localLinks).reduce(async (acc, anchor) => {
        const href = anchor.getAttribute("href");
        if (href && href.endsWith(".torrent")) {
          downloadLinks.push(href);
        }
        return acc;
      }, []);

      const lists = localDocument.getElementsByTagName("ul");
      const lastList = lists[lists.length - 1];
      const listItems = lastList?.getElementsByTagName("li");
      const activePage = Number(url.searchParams.get("page"));
      const nextListItem = listItems?.find(
        ({ childNodes }) =>
          !Number.isNaN(Number(childNodes[0].innerHTML)) &&
          Number(childNodes[0].innerHTML) > activePage,
      );

      if (nextListItem) {
        url.searchParams.set("page", Number(url.searchParams.get("page")) + 1);
        url.search = decodeURIComponent(url.search);
        await appendLinks(url, letter, true);
      }
    } catch (error) {
      console.log(error?.message);
      await appendLinks(href, letter, isSameLetter);
    }
  };

  const collect = async () => {
    for (let i = 0; i < alphabet.length; i++) {
      await appendLinks(providedUrl, alphabet[i]);
    }
    await appendLinks(providedUrl, false);
  };

  const downloadFile = async (index, retryCount) => {
    const split = downloadLinks[index].split("/");
    const fileName = split[split.length - 1];

    split.pop();
    const path = split.join("/");

    await fs.promises.mkdir(
      `./dump/${decodeURI(path)}`,
      { recursive: true },
      (err) => {
        console.log(err);
      },
    );

    const downloadUrl = `${downloadLinks[index].startsWith("/") ? providedUrl.replace(/\/\?.*/gim, "") : ""}${downloadLinks[index]}`;
    console.log(`downloading file ${index + 1} of ${downloadLinks.length}`);
    const filePath = `./dump/${decodeURI(path)}/${decodeURI(fileName)}`;
    const { body } = await fetch(downloadUrl).catch(async (err) => {
      if (retryCount >= max_retries) {
        console.log("Max retries attempted");
        retryDownloadLinks.push(downloadLinks[index]);
        console.log(retryDownloadLinks.join("\n"));
      } else {
        console.log("Fetch failed, retrying");
        console.log(err);
        const fileExists = fs.existsSync(filePath);
        if (fileExists) await fsPromise.unlink(filePath);
        downloadFile(index, retryCount + 1);
      }
    });

    const downloadResBody = await new Response(body).text();

    const tooManyRequests = downloadResBody.includes("429 Too Many Requests");
    if (tooManyRequests) {
      console.log("429: Too many requests, retry in 5 minutes");
      setTimeout(
        () => {
          appendLinks(href, letter, isSameLetter);
        },
        1000 * 60 * 5,
      );
      Promise.resolve();
      return;
    }

    new Readable.fromWeb(body).pipe(
      fs.createWriteStream(filePath, { flags: "wx" }).on("error", (err) => {
        console.log(err);
        if (index + (downloadThreads || 1) < downloadLinks.length) {
          downloadFile(index + (downloadThreads || 1));
        }
      }),
    );

    if (index + (downloadThreads || 1) < downloadLinks.length) {
      downloadFile(index + (downloadThreads || 1));
    }
  };

  const download = async () => {
    downloadLinks = downloadLinks.reduce((acc, downloadLink) => {
      if (!acc.includes(downloadLink)) acc.push(downloadLink);
      return acc;
    }, []);
    if (downloadThreads) {
      for (let i = 0; i < downloadThreads; i++) {
        setTimeout(
          () => {
            downloadFile(i);
          },
          i * 250 + (Math.random() / 4) * 100,
        );
      }
    } else {
      downloadFile(0);
    }
    Promise.resolve();
  };

  if (!providerType) {
    console.log("No type provided");
  }

  if (providerType === "collect") {
    console.log("Collecting links");
    await collect();

    await fsPromise.writeFile(
      "linkList.json",
      `${JSON.stringify(downloadLinks)}`,
      "utf8",
    );
  }

  if (providerType === "download") {
    console.log("Downloading links");
    const fileRead = await fsPromise.readFile("linkList.json", "utf8");
    if (!fileRead) {
      console.log("No filelist generated yet");
      return;
    }

    downloadLinks = JSON.parse(fileRead);

    await download();
  }
})();
