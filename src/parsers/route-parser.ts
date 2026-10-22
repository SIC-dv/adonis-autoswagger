import type { options } from "../types";

export class RouteParser {
    options: options;
    constructor(options: options) {
        this.options = options;
    }

    /*
      extract path-variables, tags and the uri-pattern
    */
    extractInfos(p: string) {
        let parameters = {};
        let pattern = "";
        let tags = [];
        let required: boolean;

        const split = p.split("/");
        if (split.length > this.options.tagIndex) {
            tags = [split[this.options.tagIndex].toUpperCase()];
        }
        split.forEach((part) => {
            if (part.startsWith(":")) {
                required = !part.endsWith("?");
                const param = part.replace(":", "").replace("?", "");
                part = "{" + param + "}";
                parameters = {
                    ...parameters,
                    [param]: {
                        in: "path",
                        name: param,
                        schema: {
                            type: "string",
                        },
                        required: required,
                    },
                };
            }
            pattern += "/" + part;
        });
        if (pattern.endsWith("/")) {
            pattern = pattern.slice(0, -1);
        }
        return { tags, parameters, pattern };
    }
}