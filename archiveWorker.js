const fs = require('fs');
const path = require('path');
const util = require('util');
const moment = require('moment');
const sanitize = require("sanitize-filename");
const events = require('events');
const request = require('request');
const RateLimiter = require('limiter').RateLimiter;
const imageLimiter = new RateLimiter(1, 1000); // x requests every y ms
const notify = require('./notify');

var method = ArchiveWorker.prototype;

function ArchiveWorker(db, mangaInfo, limiter, callback, errcallback) {

    this._db = db;
    this._manga = mangaInfo;
    this._limiter = limiter;
    this._callback = callback; // function (archiveWorker)
    this._errcallback = errcallback;
    this._chapters = [];
    this._promiseWorkers = [];
    this._dirname = null;
    this._infoRaw = "";
    this._dirReservationFail = false;

}

method.getMangaDescription = function ()
{
    return this.stripJunk(this._manga.description);
};

method.getMangaDirname = function ()
{
    //return util.format("%s (%s)", sanitize(this._manga.title), moment(Date.now()).format('dd-mmm-yyyy'));
    //console.log("getMangaDirname", this._manga);
    return sanitize(this._manga.title).toString().replace(/^\.+/, "");
};

method.getChapterDirname = function (chapter)
{
    let chapterString = chapter.ch.toString().replace('x', '.').replace('p', '.');
    let [primary, secondary] = chapterString.split(".");
    if (secondary !== undefined) { //Checks that secondary number exists. e.g. `7` => `7`. If you use `7.`, then- Wait, why you using `7.`?
        chapterString = [primary.padStart(3, "0"), secondary].join(".");
    } else if (secondary === "") {
        console.warn(`Trailing "." for Chapter: ${chapterString}`);
    } else {
        chapterString = primary.padStart(3, "0");
    }
    //let chapterString = chapter.ch.toString().padStart(3, '0');
    let volumeString = chapter.vol.toString().padStart(2, '0');
    let groupString = chapter.groups.map(grp => "["+grp+"]").join(' ');

    //console.log("getChapterDirname", this._manga);
    return sanitize(util.format("%s - c%s (v%s) %s", this._manga.title, chapterString, volumeString, groupString)).toString().replace(/^\.+/, "");
};

method.getTorrentInfo = function () {
    return this._infoRaw;
};

method.getAbsolutePath = function () {
    return this._dirname;
};

method.getMangaName = function () {
    return this.getMangaDirname();
};

method.getMangaId = function () {
    return this._manga.id;
};

method.addInfoFile = function ()
{
    let destinationPath = path.join(process.env.BASE_DIR, this.getMangaDirname());

    if (!fs.existsSync(destinationPath))
        fs.mkdirSync(destinationPath);

    destinationPath = path.join(destinationPath, "info.txt");

    this._chapters.sort((a, b) => {
        let vdiff = a.vol - b.vol;
        return vdiff !== 0 ? vdiff : a.ch - b.ch;
    });

    let vol = this._chapters[0].vol;
    let chapterList = "Volume "+vol+"\n";
    let groupList = [];

    for (let i = 0; i < this._chapters.length; i++) {
        let ch = this._chapters[i];
        if (ch.vol !== vol) {
            // Print volume line
            chapterList += "Volume "+ch.vol+"\n";
            vol = ch.vol;
        }
        // Print chapter line
        chapterList += " * Chapter "+ch.ch;
        // Print title line
        chapterList += ch.title ? " - "+ch.title : "";
        chapterList += "\n";

        // Group
        for (let j = 0; j < ch.groups.length; j++) {
            let grp = ch.groups[j];
            if (grp !== 'no group' && grp !== 'Unknown' && groupList.indexOf(grp) === -1)
                groupList.push(grp);
        }
    }

    let groupListString = groupList.map(g => "- "+g.trim().replace(/,\s*/i, '')).join("\n");

    let infoRaw = fs.readFileSync('info.template.txt', 'utf8');
    let descrRaw = fs.readFileSync('description.template.txt', 'utf8');
    let infoFile = infoRaw
        .replace(/{id}/i, this._manga.id)
        .replace(/{title}/i, this._manga.title)
        .replace(/{url}/i, "https://mangadex.org/manga/"+this._manga.id)
        .replace(/{description}/i, this.getMangaDescription())
        .replace(/{date}/i, moment(Date.now()).format('MMMM Do YYYY, h:mm:ss a'))
        .replace(/{version}/i, global.thisVersion)
        .replace(/{chapterlist}/i, chapterList.trim())
        .replace(/{grouplist}/i, groupListString)
    ;
    this._infoRaw = descrRaw
        .replace(/{id}/i, this._manga.id)
        .replace(/{title}/i, this._manga.title)
        .replace(/{url}/i, "https://mangadex.org/manga/"+this._manga.id)
        .replace(/{description}/i, this.getMangaDescription())
        .replace(/{date}/i, moment(Date.now()).format('MMMM Do YYYY, h:mm:ss a'))
        .replace(/{version}/i, global.thisVersion)
        .replace(/{chapternum}/i, this._chapters.length)
        .replace(/{grouplist}/i, groupListString)
    ;
    fs.writeFileSync(destinationPath, infoFile, {encoding: 'utf8'});
};

method.stripJunk = function (string) {
    // Strip useless shit
    return string
        .replace(/\[url=([^\]]*)](.*?)\[\/url]/ig, '$2 ($1)')
        //.replace(/\[url=([^\s\]]+?)\s*\](.*?(?=\[\/url\]))\[\/url\]/g, '$2 ($1)')
        .replace(/\[\/?(?:b|u|i|spoiler|list|url|\/\*)\]/ig, '')
        .replace(/<\/?[bui]>/ig, '')
        .replace(/<br\s*\/?>/ig, "\n")
        .replace(/\[\*\]/g, '* ')
        ;
};

method.addChapter = function (chapter)
{
    //console.log(chapter);
    let self = this;

    this._chapters.push(chapter);

    // Add new chapter downloader
    let promiseWorker = new Promise((resolve, reject) => {

        // Create path & dirs
        self._dirname = path.join(process.env.BASE_DIR, self.getMangaDirname());

        // Handle directory name collisions (ex: Clover #4113 and Clover #5772)
        try {
            let reservation = this._db.getDirReservation(this._manga.id, this._manga.title, self._dirname);
            //console.log(this._manga.id, this._manga.title, self._dirname);
            //console.log(reservation);
            //console.log(this._dirReservationFail);
            if (reservation.mangaId !== this._manga.id) {
                // Collision! Append the mangaid so it gets unique again
                self._dirname += " ("+this._manga.id+")";
                if (!this._dirReservationFail) {
                    console.log(`Dir reservation failure for manga #${this._manga.id} ${this._manga.title} trying to reserve directory ${self._dirname} which is already reserved by #${reservation.mangaId} ${reservation.mangaTitle}`);
                    self._dirReservationFail = true;
                    reservation = this._db.getDirReservation(this._manga.id, this._manga.title, self._dirname);
                    notify.warn(`Directory collision due to manga with the same name. manga #${this._manga.id} ${this._manga.title} has been renamed to directory ${self._dirname}`);
                    console.log("Updated directory reservation: ", reservation);
                }
            }
        } catch (err) {
            this._dirReservationFail = true;
            notify.err("Exception during reservation db check: "+(err ? err : "undefined err"));
            reject(`Dir reservation failure for manga #${this._manga.id} ${this._manga.title}, reject called in catch block with error ${err}`);
            return;
        }

        if (!fs.existsSync(self._dirname))
            fs.mkdirSync(self._dirname);
        let dirname = path.join(self._dirname, self.getChapterDirname(chapter));

        if (!fs.existsSync(dirname))
            fs.mkdirSync(dirname);

        console.log("Ch. dest: "+dirname);

        let imageWorkers = [];

        for (let i = 0; i < chapter.pages.length; i++) {
            let page = chapter.pages[i];
            let pageNum = 1+i;
            let ext = page.split('.')[1];
            let destinationPath = path.join(dirname, pageNum.toString().padStart(3, '0')+"."+ext);

            if (!process.flags.images || fs.existsSync(destinationPath)) {
                let imgUrl = chapter.url.toString() + page;
                //console.log("Skipping "+imgUrl);
                //console.log("File "+destinationPath+" already exists. Skipping...");
                continue;
            }

            let picNum = i+1;
            let picTotal = chapter.pages.length;

            imageWorkers.push(new Promise((resolve, reject) => {

                imageLimiter.removeTokens(1, () => {

                    try {
                        let imgUrl = chapter.url.toString() + page;

                        request.get({
                            url: imgUrl,
                            timeout: (process.env.REQUEST_TIMEOUT || 5) * 1000
                        }, (err, res, body) => {
                            if (err) {
                                console.error(err);
                                reject("Failed to download "+imgUrl+", statusCode: "+(res ? res.statusCode : "result undefined"));
                            }
                        }).on('response', (res) => {
                            if (res.statusCode !== 200) {
                                reject("Failed to download "+imgUrl+", statusCode: "+res.statusCode);
                            } else {
                                console.info("DL ("+picNum+"/"+picTotal+") "+imgUrl);

                                res.pipe(fs.createWriteStream(destinationPath));
                                res.on('end', resolve);
                            }
                        }).on('error', (err) => {
                            console.error("Failed to download image from "+imgUrl, err);
                            reject("Failed to download image from "+imgUrl);
                        }).on('close', () => {
                            // console.log("Image download stream closed");
                        }).on('abort', () => {
                            console.log("Image download aborted");
                            //reject(); // The above error block already rejects the promise on ESOCKETTIMEDOUT
                        }).on('drain', () => {
                            console.log("Image download socket drained");
                        }).on('timeout', () => {
                            console.log("Image download timeout reached");
                            reject();
                        });
                    } catch (err) {
                        console.error("Image download threw unhandled exception", err);
                        reject("Unhandled Exception catch block inside imageworker with err: "+err);
                    }

                });
            }));
        }
        Promise.all(imageWorkers).then(resolve)
            .catch((reason) => {
                console.error("Imageworker threw an exception inside a catch block (this is recoverable): "+reason);
                notify.err("Imageworker threw an exception inside a catch block (this is recoverable): "+(reason ? reason.toString() : "no reason"));
                reject("error caught in a imageWorker: "+reason);
            });

    });
    self._promiseWorkers.push(promiseWorker);

    if (self._promiseWorkers.length === self._manga.numChapters) {
        // Last chapter worker has been added. Time to start the downloads
        Promise.all(self._promiseWorkers).then(() => {

            console.log(util.format("Archive Worker finished downloading "+self._manga.title+" with %d chapters.", self._manga.numChapters));
            notify.info("Archive worker finished downloading "+self._manga.title+" with "+self._manga.numChapters+" chapters");

            // Add info file after all chapters have been parsed & downloaded
            this.addInfoFile();

            self._callback(self);

        }).catch((reason) => {

            console.error(util.format("Archive Worker failed while trying to download chapter. Reason: %s", reason ? reason.toString() : "no reason"));
            notify.err("Archive worker failed while trying to download chapter. Reason: "+(reason ? reason.toString() : "no reason"));
            //throw new Error();
            self._errcallback();

        });
    }
};

module.exports = ArchiveWorker;