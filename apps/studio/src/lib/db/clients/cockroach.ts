import globals from "@/common/globals";
import pg, { PoolConfig } from "pg";
import { IDbConnectionDatabase, IDbConnectionServer, IDbConnectionServerConfig } from "../types";
import { SupportedFeatures, TableIndex, TablePartition, TableProperties, TableTrigger } from "../models";
import { PostgresClient } from "./postgresql";
import _ from 'lodash';


export class CockroachClient extends PostgresClient {

  constructor(server: any, database: IDbConnectionDatabase) {
    super(server, database);
  }

  supportedFeatures(): SupportedFeatures {
    return {
      customRoutines: true,
      comments: true,
      properties: true,
      partitions: false,
      editPartitions: false
    };
  }

  async listTablePartitions(_table: string, _schema: string): Promise<TablePartition[]> {
    return null;
  }

  async listTableTriggers(_table: string, _schema?: string): Promise<TableTrigger[]> {
    // unsupported https://www.cockroachlabs.com/docs/stable/sql-feature-support.html
    return [];
  }

  async listTableIndexes(_db: string, table: string, schema?: string): Promise<TableIndex[]> {
    const sql = `
     show indexes from ${this.tableName(table, schema)};
    `

    const result = await this.driverExecuteSingle(sql);
    const grouped = _.groupBy(result.rows, 'index_name')
    return Object.keys(grouped).map((indexName: string, idx) => {
      const columns = grouped[indexName].filter((c) => !c.implicit)
      const first: any = grouped[indexName][0]
      return {
        id: idx.toString(),
        name: indexName,
        table: table,
        schema: schema,
        // v21.2 onwards changes index names for primary keys
        primary: first.index_name === 'primary' || first.index_name.endsWith('pkey'),
        unique: !first.non_unique,
        columns: _.sortBy(columns, ['seq_in_index']).map((c: any) => ({
          name: c.column_name,
          order: c.direction
        }))

      }
    })
  }

  async getTableProperties(table: string, schema?: string): Promise<TableProperties> {
    const detailsPromise = Promise.resolve({ rows: [] });
    const triggersPromise = Promise.resolve([]);
    const partitionsPromise = Promise.resolve([]);

    const [
      result,
      indexes,
      relations,
      triggers,
      partitions,
      owner
    ] = await Promise.all([
      detailsPromise,
      this.listTableIndexes(table, schema),
      this.getTableKeys("", table, schema),
      triggersPromise,
      partitionsPromise,
      this.getTableOwner(table, schema)
    ]);

    const props = result.rows.length > 0 ? result.rows[0] : {};
    return {
      description: props.description,
      indexSize: Number(props.index_size),
      size: Number(props.table_size),
      indexes,
      relations,
      triggers,
      partitions,
      owner
    };
  }

  protected async configDatabase(server: { sshTunnel: boolean, config: IDbConnectionServerConfig }, database: { database: string }) {
    let optionsString = undefined;
    const cluster = server.config.options?.cluser || undefined;
    if (cluster) {
      optionsString = `--cluster=${cluster}`;
    }

    const config: PoolConfig = {
      host: server.config.host,
      port: server.config.port || undefined,
      password: server.config.password || undefined,
      database: database.database,
      max: 5, // max idle connections per time (30 secs)
      connectionTimeoutMillis: globals.psqlTimeout,
      idleTimeoutMillis: globals.psqlIdleTimeout,
      // not in the typings, but works.
      // @ts-expect-error Fix Typings
      options: optionsString
    };

    return this.configurePool(config, server, null);
  }

  protected async getTypes(): Promise<any> {
    const sql = `
      SELECT      n.nspname as schema, t.typname as typename, t.oid::int4 as typeid
      FROM        pg_type t
      LEFT JOIN   pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE       (t.typrelid = 0 OR (SELECT c.relkind = 'c' FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid))
      AND     NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type el WHERE el.oid = t.typelem AND el.typarray = t.oid)
      AND     n.nspname NOT IN ('pg_catalog', 'information_schema');
    `;

    const data = await this.driverExecuteSingle(sql);
    const result: any = {}
    data.rows.forEach((row: any) => {
      result[row.typeid] = row.typename
    })
    _.merge(result, _.invert(pg.types.builtins))
    result[1009] = 'array'
    return result
  }
}

export default async function(server: IDbConnectionServer, database: IDbConnectionDatabase) {
  const client = new CockroachClient(server, database);
  await client.connect();
  return client;
}
