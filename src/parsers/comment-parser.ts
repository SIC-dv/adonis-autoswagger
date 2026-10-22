import HTTPStatusCode from "http-status-code";
import util from "util";
import extract from "extract-comments";
import fs from "fs";
import _ from "lodash";
import { isJSONString, getBetweenBrackets } from "../helpers";
import ExampleGenerator from "../example";
import type { options } from "../types";

export class CommentParser {
    private parsedFiles: { [file: string]: string } = {};
    public exampleGenerator: ExampleGenerator;

    options: options;

    constructor(options: options) {
        this.options = options;
    }

    private parseAnnotations(lines: string[]) {
        let summary = "";
        let tag = "";
        let description = "";
        let operationId;
        let responses = {};
        let requestBody;
        let parameters = {};
        let headers = {};

        let readingDescription = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("@description")) {
                description = line.replace(/^@description\s*/, "");
                readingDescription = true;
                continue;
            }

            if (!line.startsWith("@")) {
                if (readingDescription && line.trim()) {
                    description += ` ${line.trim()}`;
                }
                continue;
            }

            readingDescription = false;

            if (line.startsWith("@summary")) {
                summary = line.replace(/^@summary\s*/, "");
            } else if (line.startsWith("@tag")) {
                tag = line.replace(/^@tag\s*/, "");
            } else if (line.startsWith("@operationId")) {
                operationId = line.replace(/^@operationId\s*/, "");
            } else if (line.startsWith("@responseBody")) {
                let responseLine = line.replace(/^@responseBody\s*/, "");

                const firstSeparator = responseLine.indexOf(" - ");
                if (firstSeparator !== -1) {
                    const status = responseLine.substring(0, firstSeparator);
                    let remaining = responseLine.substring(firstSeparator + 3);

                    if (!isJSONString(remaining)) {
                        let candidate = remaining;
                        let j = i + 1;

                        while (j < lines.length && !lines[j].startsWith("@")) {
                            candidate += "\n" + lines[j];

                            if (isJSONString(candidate)) {
                                remaining = candidate;
                                i = j;
                                break;
                            }

                            j++;
                        }
                    }

                    responseLine = `${status} - ${remaining}`;
                }

                responses = {
                    ...responses,
                    ...this.parseResponseBody(
                        `@responseBody ${responseLine}`
                    ),
                };
            } else if (line.startsWith("@responseHeader")) {
                const header = this.parseResponseHeader(line);

                if (header === null) {
                    console.error("Error with line: " + line);
                    continue;
                }

                headers[header.status] = {
                    ...headers[header.status],
                    ...header.header,
                };
            } else if (line.startsWith("@requestBody")) {
                let body = line.replace(/^@requestBody\s*/, "");

                if (!isJSONString(body)) {
                    let candidate = body;
                    let j = i + 1;

                    while (j < lines.length && !lines[j].startsWith("@")) {
                        candidate += "\n" + lines[j];

                        if (isJSONString(candidate)) {
                            body = candidate;
                            i = j;
                            break;
                        }

                        j++;
                    }
                }

                requestBody = this.parseBody(
                    `@requestBody ${body}`,
                    "requestBody"
                );
            } else if (line.startsWith("@requestFormDataBody")) {
                const parsedBody = this.parseRequestFormDataBody(line);

                if (parsedBody) {
                    requestBody = parsedBody;
                }
            } else if (line.startsWith("@param")) {
                parameters = {
                    ...parameters,
                    ...this.parseParam(line),
                };
            }
        }

        for (const [key, value] of Object.entries(responses)) {
            if (headers[key] !== undefined) {
                responses[key]["headers"] = headers[key];
            }

            if (!responses[key]["description"]) {
                const contentType = Object.keys(
                    responses[key]["content"] || {}
                )[0];

                responses[key]["description"] =
                    `Returns **${key}** (${HTTPStatusCode.getMessage(key)})` +
                    (contentType ? ` as **${contentType}**` : "");
            }
        }

        return {
            description,
            responses,
            requestBody,
            parameters,
            summary,
            operationId,
            tag,
        };
    }

    private parseParam(line: string) {
        let where = "path";
        let required = true;
        let type = "string";
        let example: any = null;
        let enums = [];

        if (line.startsWith("@paramUse")) {
            let use = getBetweenBrackets(line, "paramUse");
            const used = use.split(",");
            let h = [];
            used.forEach((u) => {
                if (typeof this.options.common.parameters[u] === "undefined") {
                    return;
                }
                const common = this.options.common.parameters[u];
                h = [...h, ...common];
            });

            return h;
        }

        if (line.startsWith("@paramPath")) {
            required = false;
        }
        if (line.startsWith("@paramQuery")) {
            required = false;
        }

        let m = line.match("@param([a-zA-Z]*)");
        if (m !== null) {
            where = m[1].toLowerCase();
            line = line.replace(m[0] + " ", "");
        }

        let [param, des, meta] = line.split(" - ");
        if (typeof param === "undefined") {
            return;
        }
        if (typeof des === "undefined") {
            des = "";
        }

        if (typeof meta !== "undefined") {
            if (meta.includes("@required")) {
                required = true;
            }
            let en = getBetweenBrackets(meta, "enum");
            example = getBetweenBrackets(meta, "example");
            const mtype = getBetweenBrackets(meta, "type");
            if (mtype !== "") {
                type = mtype;
            }
            if (en !== "") {
                enums = en.split(",");
                example = enums[0];
            }
        }

        let p = {
            in: where,
            name: param,
            description: des,
            schema: {
                example: example,
                type: type,
            },
            required: required,
        };

        if (enums.length > 1) {
            p["schema"]["enum"] = enums;
        }

        return { [param]: p };
    }

    private parseResponseHeader(responseLine: string) {
        let description = "";
        let example: any = "";
        let type = "string";
        let enums = [];
        const line = responseLine.replace("@responseHeader ", "");
        let [status, name, desc, meta] = line.split(" - ");

        if (typeof status === "undefined" || typeof name === "undefined") {
            return null;
        }

        if (typeof desc !== "undefined") {
            description = desc;
        }

        if (name.includes("@use")) {
            let use = getBetweenBrackets(name, "use");
            const used = use.split(",");
            let h = {};
            used.forEach((u) => {
                if (typeof this.options.common.headers[u] === "undefined") {
                    return;
                }
                const common = this.options.common.headers[u];
                h = { ...h, ...common };
            });

            return {
                status: status,
                header: h,
            };
        }

        if (typeof meta !== "undefined") {
            example = getBetweenBrackets(meta, "example");
            const mtype = getBetweenBrackets(meta, "type");
            if (mtype !== "") {
                type = mtype;
            }
        }

        if (example === "" || example === null) {
            switch (type) {
                case "string":
                    example = "string";
                    break;
                case "integer":
                    example = 1;
                    break;
                case "float":
                    example = 1.5;
                    break;
            }
        }

        let h = {
            schema: { type: type, example: example },
            description: description,
        };

        if (enums.length > 1) {
            h["schema"]["enum"] = enums;
        }
        return {
            status: status,
            header: {
                [name]: h,
            },
        };
    }

    private parseResponseBody(responseLine: string) {
        const line = responseLine.replace(/^@responseBody\s*/, "");
        const firstSeparator = line.indexOf(" - ");

        if (firstSeparator === -1) {
            return;
        }

        const status = line.substring(0, firstSeparator).trim();
        const remaining = line.substring(firstSeparator + 3).trim();

        let res = remaining;
        let desc: string | undefined;

        if (isJSONString(remaining)) {
            res = remaining;
        } else {
            // Preserve the existing reference and description syntax.
            const secondSeparator = remaining.indexOf(" - ");

            if (secondSeparator !== -1) {
                res = remaining.substring(0, secondSeparator).trim();
                desc = remaining.substring(secondSeparator + 3).trim();
            }
        }

        const responses = {
            [status]: {
                ...this.parseBody(res, "responseBody"),
                ...(desc ? { description: desc } : {}),
            },
        };

        return responses;
    }

    private parseRequestFormDataBody(rawLine: string) {
        const line = rawLine.replace("@requestFormDataBody ", "");
        let json = {},
            required = [];
        const isJson = isJSONString(line);
        if (!isJson) {
            // try to get json from reference
            let rawRef = line.substring(line.indexOf("<") + 1, line.lastIndexOf(">"));

            const cleandRef = rawRef.replace("[]", "");
            if (cleandRef === "") {
                return;
            }
            const parsedRef = this.exampleGenerator.parseRef(line, true);
            let props = [];
            const ref = this.exampleGenerator.schemas[cleandRef];
            const ks = [];
            if (ref.required && Array.isArray(ref.required))
                required.push(...ref.required);
            Object.entries(ref.properties).map(([key, value]) => {
                if (typeof parsedRef[key] === "undefined") {
                    return;
                }
                ks.push(key);
                if (value["required"]) required.push(key);
                props.push({
                    [key]: {
                        type:
                            typeof value["type"] === "undefined" ? "string" : value["type"],
                        format:
                            typeof value["format"] === "undefined"
                                ? "string"
                                : value["format"],
                    },
                });
            });
            const p = props.reduce((acc, curr) => ({ ...acc, ...curr }), {});
            const appends = Object.keys(parsedRef).filter((k) => !ks.includes(k));
            json = p;
            if (appends.length > 0) {
                appends.forEach((a) => {
                    json[a] = parsedRef[a];
                });
            }
        } else {
            json = JSON.parse(line);
            for (let key in json) {
                if (json[key].required === "true") {
                    required.push(key);
                }
            }
        }
        // No need to try/catch this JSON.parse as we already did that in the isJSONString function

        return {
            content: {
                "multipart/form-data": {
                    schema: {
                        type: "object",
                        properties: json,
                        required,
                    },
                },
            },
        };
    }

    private parseBody(rawLine: string, type: string) {
        let line = rawLine.replace(`@${type} `, "");

        const isJson = isJSONString(line);

        if (isJson) {
            // No need to try/catch this JSON.parse as we already did that in the isJSONString function
            const json = JSON.parse(line);
            const o = this.jsonToObj(json);
            return {
                content: {
                    "application/json": {
                        schema: {
                            type: Array.isArray(json) ? "array" : "object",
                            ...(Array.isArray(json) ? { items: this.arrayItems(json) } : o),
                        },

                        example: this.exampleGenerator.jsonToRef(json),
                    },
                },
            };
        }
        return this.exampleGenerator.parseRef(line);
    }

    arrayItems(json) {
        const oneOf = [];

        const t = typeof json[0];

        if (t === "string") {
            json.forEach((j) => {
                const value = this.exampleGenerator.parseRef(j);

                if (_.has(value, "content.application/json.schema.$ref")) {
                    oneOf.push({
                        $ref: value["content"]["application/json"]["schema"]["$ref"],
                    });
                }
            });
        }

        if (oneOf.length > 0) {
            return { oneOf: oneOf };
        }
        return { type: typeof json[0] };
    }

    jsonToObj(json: any) {
        // Handle null values safely.
        if (json === null) {
            return { nullable: true };
        }

        // Handle arrays separately from regular objects.
        if (Array.isArray(json)) {
            return {
                type: "array",
                items: json.length > 0
                    ? this.jsonToObj(json[0])
                    : {},
            };
        }

        // Handle primitive values safely.
        if (typeof json !== "object") {
            return { type: typeof json };
        }

        const o = {
            type: "object",
            properties: Object.keys(json)
                .map((key) => {
                    const t = typeof json[key];
                    const v = json[key];
                    let value = v;

                    if (t === "object") {
                        value = this.jsonToObj(v);
                    }

                    if (
                        t === "string" &&
                        v.includes("<") &&
                        v.includes(">")
                    ) {
                        value = this.exampleGenerator.parseRef(v);

                        if (v.includes("[]")) {
                            let ref = "";

                            if (
                                _.has(
                                    value,
                                    "content.application/json.schema.$ref"
                                )
                            ) {
                                ref =
                                    value["content"]["application/json"]
                                    ["schema"]["$ref"];
                            }

                            if (
                                _.has(
                                    value,
                                    "content.application/json.schema.items.$ref"
                                )
                            ) {
                                ref =
                                    value["content"]["application/json"]
                                    ["schema"]["items"]["$ref"];
                            }

                            value = {
                                type: "array",
                                items: { $ref: ref },
                            };
                        } else {
                            value = {
                                $ref:
                                    value["content"]["application/json"]
                                    ["schema"]["$ref"],
                            };
                        }
                    }

                    return { [key]: value };
                })
                .reduce((acc, curr) => ({ ...acc, ...curr }), {}),
        };

        return o;
    }

    async getAnnotations(file: string, action: string) {
        if (!file) return;

        let source: string;

        if (typeof this.parsedFiles[file] !== "undefined") {
            source = this.parsedFiles[file];
        } else {
            try {
                source = await fs.promises.readFile(file, "utf8");
                this.parsedFiles[file] = source;
            } catch (e) {
                console.error("\x1b[31m✗ File not found\x1b[0m", file);
                return;
            }
        }

        const annotations = {};
        const comments = extract(source);

        for (const comment of comments) {
            if (comment.type !== "BlockComment") continue;

            const lines = comment.value
                .split("\n")
                .map((line) => line.replace(/^\s*\*\s?/, "").trim())
                .filter((line) => line !== "");

            if (lines[0] !== `@${action}`) continue;

            annotations[action] = this.parseAnnotations(lines);
            break;
        }

        return annotations;
    }
}