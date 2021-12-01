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

import Action from "@web-eid/web-eid-library/models/Action";
import UserTimeoutError from "@web-eid/web-eid-library/errors/UserTimeoutError";
import ServerTimeoutError from "@web-eid/web-eid-library/errors/ServerTimeoutError";
import { serializeError } from "@web-eid/web-eid-library/utils/errorSerializer";

import NativeAppService from "../services/NativeAppService";
import WebServerService from "../services/WebServerService";
import HttpResponse from "../../models/HttpResponse";
import { MessageSender } from "../../models/Browser/Runtime";
import { throwAfterTimeout } from "../../shared/utils/timing";
import pick from "../../shared/utils/pick";
import { getSenderUrl } from "../../shared/utils/sender";

export default async function sign(
  postPrepareSigningUrl: string,
  postFinalizeSigningUrl: string,
  getCorsConfigUrl: string | null,
  headers: Record<string, string>,
  userInteractionTimeout: number,
  serverRequestTimeout: number,
  sender: MessageSender,
  lang?: string,
): Promise<object | void> {
  let webServerService: WebServerService | undefined;
  let nativeAppService: NativeAppService | undefined;

  try {
    webServerService = new WebServerService(sender);
    nativeAppService = new NativeAppService();

    if (getCorsConfigUrl) {
      await webServerService.enableCors(Action.SIGN, getCorsConfigUrl);
    }

    let nativeAppStatus = await nativeAppService.connect();

    console.log("Sign: connected to native", nativeAppStatus);

    const certificateResponse = await Promise.race([
      nativeAppService.send({
        command: "get-signing-certificate",

        arguments: {
          "origin": (new URL(postPrepareSigningUrl)).origin,

          ...(lang ? { lang } : {}),
        },
      }),

      throwAfterTimeout(userInteractionTimeout, new UserTimeoutError()),
    ]) as {
      certificate: string;
      error?: string;

      "supported-signature-algos": Array<{
        "crypto-algo":  string;
        "hash-algo":    string;
        "padding-algo": string;
      }>;
    };

    if (certificateResponse.error) {
      throw new Error(certificateResponse.error);
    } else if (!certificateResponse.certificate) {
      throw new Error("Missing signing certificate");
    }

    const { certificate } = certificateResponse;

    const supportedSignatureAlgorithms = certificateResponse["supported-signature-algos"].map((algorithmSet) => ({
      crypto:  algorithmSet["crypto-algo"],
      hash:    algorithmSet["hash-algo"],
      padding: algorithmSet["padding-algo"],
    }));

    const prepareDocumentResult = await Promise.race([
      webServerService.fetch(postPrepareSigningUrl, {
        method: "POST",

        headers: {
          ...headers,
          "Content-Type": "application/json",
        },

        body: JSON.stringify({ certificate, supportedSignatureAlgorithms }),
      }),

      throwAfterTimeout(
        serverRequestTimeout,
        new ServerTimeoutError(`server failed to respond in time - POST ${postPrepareSigningUrl}`),
      ),
    ]) as HttpResponse<{ hash: string; algorithm: string }>;

    console.log("Sign: postPrepareSigningUrl fetched", prepareDocumentResult);

    nativeAppService = new NativeAppService();
    nativeAppStatus  = await nativeAppService.connect();

    console.log("Sign: reconnected to native", nativeAppStatus);

    const signatureResponse = await Promise.race([
      nativeAppService.send({
        command: "sign",

        arguments: {
          "doc-hash":      prepareDocumentResult.body.hash,
          "hash-algo":     prepareDocumentResult.body.algorithm,
          "origin":        (new URL(getSenderUrl(sender))).origin,
          "user-eid-cert": certificate,

          ...(lang ? { lang } : {}),
        },
      }),

      throwAfterTimeout(userInteractionTimeout, new UserTimeoutError()),
    ]) as { signature: string; error: string };

    if (signatureResponse.error) {
      throw new Error(signatureResponse.error);
    } else if (!signatureResponse.signature) {

      throw new Error("Missing sign signature");
    }

    const { signature } = signatureResponse;

    console.log("Sign: user signature received from native app", signature);

    const signatureVerifyResponse = await Promise.race([
      webServerService.fetch<any>(postFinalizeSigningUrl, {
        method: "POST",

        headers: {
          ...headers,
          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          ...prepareDocumentResult.body,
          signature,
        }),
      }),

      throwAfterTimeout(
        serverRequestTimeout,
        new ServerTimeoutError(`server failed to respond in time - POST ${postFinalizeSigningUrl}`),
      ),
    ]);

    console.log("Sign: signature accepted by the server", signatureVerifyResponse);

    return {
      action: Action.SIGN_SUCCESS,

      response: {
        ...pick(signatureVerifyResponse, [
          "body",
          "headers",
          "ok",
          "redirected",
          "status",
          "statusText",
          "type",
          "url",
        ]),
      },
    };
  } catch (error) {
    console.error("Sign:", error);

    return {
      action: Action.SIGN_FAILURE,
      error:  serializeError(error),
    };
  } finally {
    nativeAppService?.close();
  }
}
