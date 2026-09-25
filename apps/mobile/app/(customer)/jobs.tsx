import { router } from 'expo-router';
import { JobCard, type JobSummary } from '@/components/JobCard';
import { ErrorText, Loading, Muted, Screen } from '@/components/ui';
import { useApi } from '@/lib/useApi';

export default function CustomerJobs() {
  const { data, error, loading } = useApi<{ jobs: JobSummary[] }>('/jobs');
  if (loading && !data) return <Loading />;
  return (
    <Screen>
      <ErrorText error={error} />
      {data?.jobs.length === 0 && <Muted>No jobs yet. Pick a service on the Find help tab to post one.</Muted>}
      {data?.jobs.map((j) => <JobCard key={j.id} job={j} onPress={() => router.push(`/job/${j.id}`)} />)}
    </Screen>
  );
}
