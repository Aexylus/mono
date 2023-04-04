import React, {useContext} from 'react';
import {ClientIDContext} from './ClientIDContext';
import styles from './ServerConsole.module.css';
import type {Reflect} from '@rocicorp/reflect';
import type {M} from '@/demo/shared/mutators';
import {useServerLogs} from './howtoUtils';

export default function ServerConsole({reflect}: {reflect: Reflect<M>}) {
  const logs = useServerLogs(reflect);
  const {client1ID, client2ID} = useContext(ClientIDContext);
  return (
    <div className={styles.serverConsole}>
      <h4 className={styles.panelLabel}>Server Console</h4>
      <div className={styles.consoleOutput}>
        {logs &&
          logs.slice(-10).map((log, i) => {
            return (
              <p className={styles.consoleItem} key={i}>
                {log
                  .replace(client1ID, 'client1')
                  .replace(client2ID, 'client2')}
              </p>
            );
          })}
      </div>
    </div>
  );
}
