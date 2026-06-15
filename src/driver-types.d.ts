declare module 'mysql2/promise' {
  export interface Connection {
    execute(sql: string, params?: any[]): Promise<[any, any]>;
    query(sql: string, params?: any[]): Promise<[any, any]>;
    end(): Promise<void>;
  }

  function createConnection(config: any): Promise<Connection>;

  const mysql: {
    createConnection: typeof createConnection;
  };

  export default mysql;
}
