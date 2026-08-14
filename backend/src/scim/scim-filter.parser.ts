import { scimBadRequest } from "./scim-error";

const ATTRIBUTE_TO_COLUMN: Record<string, string> = {
  username: "email",
  externalid: "external_id",
  displayname: "display_name",
  active: "status",
};

const OPERATOR_TO_SQL: Record<string, (column: string, paramIndex: number) => string> = {
  eq: (column, i) => `${column} = $${i}`,
  ne: (column, i) => `${column} != $${i}`,
  co: (column, i) => `${column} ILIKE '%' || $${i} || '%'`,
  sw: (column, i) => `${column} ILIKE $${i} || '%'`,
  ew: (column, i) => `${column} ILIKE '%' || $${i}`,
};

const FILTER_PATTERN = /^\s*(\w+)\s+(eq|ne|co|sw|ew)\s+(?:"([^"]*)"|(true|false)|(\S+))\s*$/i;

export interface ParsedScimFilter {
  whereClause: string;
  param: string;
}

/**
 * Parses a single SCIM filter expression (RFC 7644 §3.4.2.2) into a
 * parameterized WHERE fragment — never string-concatenates the compared
 * value itself; only the whitelisted column name and operator are
 * interpolated, both looked up from fixed maps rather than passed
 * through from user input.
 */
export function parseScimFilter(filter: string, paramIndex: number): ParsedScimFilter {
  const match = FILTER_PATTERN.exec(filter);
  if (!match) {
    throw scimBadRequest(`Unsupported or malformed filter expression: "${filter}".`, "invalidFilter");
  }

  const [, rawAttribute, rawOperator, quotedValue, boolValue, bareValue] = match;
  const attribute = rawAttribute.toLowerCase();
  const operator = rawOperator.toLowerCase();

  const column = ATTRIBUTE_TO_COLUMN[attribute];
  if (!column) {
    throw scimBadRequest(`Filtering on attribute "${rawAttribute}" is not supported.`, "invalidFilter");
  }

  const buildClause = OPERATOR_TO_SQL[operator];
  const value = quotedValue ?? boolValue ?? bareValue;

  if (attribute === "active") {
    if (operator !== "eq" || (value !== "true" && value !== "false")) {
      throw scimBadRequest(`Filtering on "active" only supports "eq true" or "eq false".`, "invalidFilter");
    }
    return { whereClause: `status = $${paramIndex}`, param: value === "true" ? "active" : "deactivated" };
  }

  return { whereClause: buildClause(column, paramIndex), param: value };
}
