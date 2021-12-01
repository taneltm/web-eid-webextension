/*
 * Copyright (c) 2020-2021 Estonian Information System Authority
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import TlsConnectionBrokenError from "@web-eid/web-eid-library/errors/TlsConnectionBrokenError";
import TlsConnectionInsecureError from "@web-eid/web-eid-library/errors/TlsConnectionInsecureError";
import TlsConnectionWeakError from "@web-eid/web-eid-library/errors/TlsConnectionWeakError";
import CertificateChangedError from "@web-eid/web-eid-library/errors/CertificateChangedError";
import ServerRejectedError from "@web-eid/web-eid-library/errors/ServerRejectedError";
import ProtocolInsecureError from "@web-eid/web-eid-library/errors/ProtocolInsecureError";
import OriginMismatchError from "@web-eid/web-eid-library/errors/OriginMismatchError";
import Action from "@web-eid/web-eid-library/models/Action";
import MissingParameterError from "@web-eid/web-eid-library/errors/MissingParameterError";

import { OnHeadersReceivedDetails, CertificateInfo, Fingerprint } from "../../models/Browser/WebRequest";
import HttpResponse from "../../models/HttpResponse";
import { MessageSender } from "../../models/Browser/Runtime";
import { getSenderTabId, getSenderUrl } from "../../shared/utils/sender";
import coerceOrigin from "../../shared/utils/coerceOrigin";

export default class WebServerService {
  private fingerprints: Fingerprint[];
  private senderTabId: number;
  private senderOrigin: string;
  private corsOrigin?: string;

  constructor(sender: MessageSender) {
    this.fingerprints = [];
    this.senderTabId = getSenderTabId(sender);
    this.senderOrigin = new URL(getSenderUrl(sender)).origin;
  }

  async enableCors(action: Action, corsConfigUrl: string): Promise<void> {
    const originProps: Record<string, string> = {
      [Action.AUTHENTICATE]: "authUrlOrigin",
      [Action.SIGN]:         "signUrlOrigin",
    };

    if (!originProps[action]) throw new Error("invalid action");

    const response   = await this.fetch<Record<string, string>>(coerceOrigin(this.senderOrigin, corsConfigUrl));
    const corsConfig = response.body;

    const corsOrigin = corsConfig[originProps[action]];

    if (!corsOrigin?.length) {
      throw new MissingParameterError(`${originProps[action]} required in CORS configuration`);
    }

    try {
      new URL(corsOrigin);
    } catch (e) {
      throw new Error(`invalid origin in CORS configuration "${corsOrigin}"`);
    }

    this.corsOrigin = new URL(corsOrigin).origin;
  }

  hasCertificateChanged(): boolean {
    return !this.fingerprints.every((fingerprint) => this.fingerprints[0].sha256 === fingerprint.sha256);
  }

  async fetch<T>(fetchUrl: string, init?: RequestInit): Promise<HttpResponse<T>> {
    let certificateInfo: CertificateInfo | null;
    let fetchError: Error | null = null;
    let hasWebRequestPermission = false;

    fetchUrl = coerceOrigin(this.corsOrigin || this.senderOrigin, fetchUrl);

    if (!fetchUrl.toLocaleLowerCase().startsWith("https://")) {
      throw new ProtocolInsecureError(`HTTPS required for ${fetchUrl}`);
    }

    try {
      hasWebRequestPermission = await browser.permissions.contains({
        permissions: [
          "webRequest",
          "webRequestBlocking",
        ],
      });

      if (hasWebRequestPermission) {
        console.log("Got permissions for webRequest API");
      }
    } catch(error) {
      console.log("Failed to fetch webRequest permissions", error);
    }

    certificateInfo = null;

    const onHeadersReceivedListener = async (details: OnHeadersReceivedDetails): Promise<any> => {
      const securityInfo = await browser.webRequest.getSecurityInfo(
        details.requestId,
        { rawDER: true }
      );

      const accessControlAllowOrigin = details.responseHeaders?.find(
        (header) => header.name.toLocaleLowerCase() == "access-control-allow-origin"
      )?.value

      if (this.corsOrigin && this.senderOrigin !== accessControlAllowOrigin) {
        fetchError = new OriginMismatchError(
          `website origin ${this.senderOrigin} does not match Access-Control-Allow-Origin: ${accessControlAllowOrigin}`
        );

        return { cancel: true };
      }

      console.log("Inspecting webRequest securityInfo");
      /*
      switch (securityInfo.state) {
        case "secure": {
          certificateInfo = securityInfo.certificates[0];

          this.fingerprints.push(certificateInfo.fingerprint);

          if (this.hasCertificateChanged()) {
            fetchError = new CertificateChangedError();
            return { cancel: true };
          }

          console.log("TLS state is secure");

          break;
        }

        case "broken": {
          fetchError = new TlsConnectionBrokenError(`TLS connection was broken while requesting ${fetchUrl}`);
          return { cancel: true };
        }

        case "insecure": {
          fetchError = new TlsConnectionInsecureError(`TLS connection was insecure while requesting ${fetchUrl}`);
          return { cancel: true };
        }

        case "weak": {
          fetchError = new TlsConnectionWeakError(`TLS connection was weak while requesting ${fetchUrl}`);
          return { cancel: true };
        }

        default:
          fetchError = new Error("Unexpected connection security state");
          return { cancel: true };
      }
      */
    };

    if (hasWebRequestPermission) {
      /*
      browser.webRequest.onBeforeSendHeaders.addListener(
        (details: any) => {
          return {
            requestHeaders: details.requestHeaders.map(((header: any) => {
              return (
                header.name.toLowerCase() == "origin"
                  ? { ...header, value: this.senderOrigin }
                  : header
              );
            }))
          }
        },
        { urls: [fetchUrl] },
        ["blocking", "requestHeaders"]
      );
      */


      browser.webRequest.onHeadersReceived.addListener(
        onHeadersReceivedListener,
        { urls: [fetchUrl] },
        ["blocking", "responseHeaders"]
      );
    }

    try {
      const response = await browser.tabs.sendMessage(
        this.senderTabId,
        {
          action: "fetch",

          fetchUrl,

          init: {
            ...init,

            ...(
              this.corsOrigin
                ? { mode: "cors",        credentials: "include"     }
                : { mode: "same-origin", credentials: "same-origin" }
            ),
          },
        }
      ) as HttpResponse<T>;

      if (hasWebRequestPermission) {
        browser.webRequest.onHeadersReceived.removeListener(onHeadersReceivedListener);
      }

      const {
        ok,
        redirected,
        status,
        statusText,
        type,
        url,
        body,
        headers,
      } = response;

      const result = {
        certificateInfo,
        ok,
        redirected,
        status,
        statusText,
        type,
        url,
        body,
        headers,
      };

      if (!ok) {
        fetchError = fetchError || new ServerRejectedError();
        Object.assign(fetchError, {
          response: {
            ok,
            redirected,
            status,
            statusText,
            type,
            url,
            body,
            headers,
          },
        });
      }

      if (fetchError) {
        throw fetchError;
      }

      return result;

    } finally {
      if (hasWebRequestPermission) {
        browser.webRequest.onHeadersReceived.removeListener(onHeadersReceivedListener);
      }
    }
  }
}

