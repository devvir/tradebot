import { Anchor } from '@mantine/core';
import { catalog, useAsk } from '../api';
import { Dim, LastSurvey, Table, Waiting, bytes, count } from './Table';
import { linkTo } from '../App';
import type { Venue } from '../types';

/** Every venue the catalog can be asked about, and how far each has got. */
export const Venues = () => {
  const asked = useAsk<{ items: Venue[] }>('/contents/venues', catalog);

  return (
    <Waiting asked={asked}>
      {({ items }) => (
        <Table
          caption="Venues"
          rows={items}
          columns={[
            { head: 'Venue', width: '14%', cell: v => (
              <Anchor size="sm" href={linkTo({ venue: v.venue })}>{v.venue}</Anchor>) },
            { head: 'Months', width: '20%', cell: v => (v.firstMonth
              ? `${v.firstMonth} … ${v.lastMonth}`
              : <Dim>—</Dim>) },
            { head: 'Files', width: '15%', num: true, cell: v => count(v.files) },
            { head: 'Bytes', width: '12%', num: true, cell: v => bytes(v.bytes) },
            { head: 'Pending', width: '15%', num: true, cell: v => count(v.pending) },
            { head: 'Last Survey', width: '18%', cell: v => <LastSurvey of={v.lastRun} /> },
          ]}
        />
      )}
    </Waiting>
  );
};
