import { Anchor } from '@mantine/core';
import { catalogLensed, lensed, useAsk } from '../api';
import { Dim, Table, Waiting, bytes, count } from './Table';
import { linkTo } from '../App';
import type { Venue } from '../types';

/** Every venue the catalog holds files for, and how much of it is on disk. */
export const Venues = ({ lens }: { lens?: string }) => {
  const asked = useAsk<{ items: Venue[] }>(lensed('/contents/venues', lens), catalogLensed);

  return (
    <Waiting asked={asked}>
      {({ items }) => (
        <Table
          caption="Venues"
          rows={items}
          columns={[
            { head: 'Venue', width: '20%', cell: v => (
              <Anchor size="sm" href={linkTo({ venue: v.venue })}>{v.venue}</Anchor>) },
            { head: 'Months', width: '32%', cell: v => (v.firstMonth
              ? `${v.firstMonth} … ${v.lastMonth}`
              : <Dim>—</Dim>) },
            { head: 'Files', width: '15%', num: true, cell: v => count(v.files) },
            { head: 'Bytes', width: '12%', num: true, cell: v => bytes(v.bytes) },
            { head: 'Pending', width: '15%', num: true, cell: v => count(v.pending) },
          ]}
        />
      )}
    </Waiting>
  );
};
